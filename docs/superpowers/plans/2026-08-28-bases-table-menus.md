# Base table menus (header, cell, row) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Base tables a column-header menu, a cell quick-filter menu, a row context menu, and an overrides strip with "Save to view", on both the standalone and embedded tables.

**Architecture:** The server gains two request-time overrides (a `filter` and a `group_by` on the standalone GET; `group_by` on the embedded POST), validated by the existing embed validator. The UI keeps every override (quick filters, group, hidden columns; the existing sort) in `useBaseTableController` through a new `useViewOverrides` hook, renders chips in a strip, and materialises them into the view with the revision-guarded definition PUT. Menus are built on `#/components/ui/menu` (`ContextMenuTrigger` for right-click + keyboard, `MenuTrigger` for `⋯` buttons) and shared by every table surface. Row actions (open, new tab, copy wikilink, duplicate, archive) live in `useRowActions`.

**Tech Stack:** Rust 2024 / Axum 0.8 / utoipa / serde_json; React 19 / TypeScript / React Aria Components / TanStack Query / Zustand; Vitest + Testing Library; Bun.

**Spec:** `docs/superpowers/specs/2026-08-28-bases-table-menus-design.md` — read it first; it is the binding authority.

## Global Constraints

- Never run `bun run format` or `biome check --write` across `ui/src`; format only the files you touched (`bunx biome check --write <files>`). Run `cargo fmt` freely.
- `cargo test` needs `ui/dist/` (already seeded in this worktree). Never pipe `cargo test` output through tools that hide the exit status; read the summary line.
- Never run `clep` without `CLEPSYDRA__VAULT__ROOT` pointing at a scratch vault; the ambient config targets the live vault.
- After any change to a Rust DTO or route, regenerate the schema offline: `cargo run -q --example openapi > target/openapi.json && (cd ui && bun run openapi:file)` and commit `ui/src/api/schema.d.ts`. Do not use `bun run openapi` (it targets the user's live server on port 3000).
- Group override sentinel: the **empty string** means "evaluate flat"; absent means "keep the view's grouping". Same on both endpoints.
- Quick filters compose as `Filter::All([...])` after the base filter and the view filter; a single conjunct is sent bare.
- Every menu item text equals its chip text. Copy from the spec tables verbatim.
- Menus are absent (header) or reduced to navigation items (row) when the table is `readOnly`.
- The `title` column can never be hidden; the last visible column can never be hidden.
- Commit after every task with a conventional message (`feat(bases): …`, `test(bases): …`).
- UI tests run with `cd ui && bun run test <file>`; typecheck with `cd ui && bun run typecheck`; lint with `cd ui && bun run lint`.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/vault/query.rs` | `is_groupable(&ResolvedField)` — one source of truth for groupable fields |
| `src/vault/base_embed.rs` | `GroupOverride`, `group_override(raw)`, group validation, effective grouping in window validation, `composed_query_spec` override |
| `src/api/bases.rs` | `ViewParams.filter/group_by`, `BaseViewEvaluateRequest.group_by`, standalone override parsing |
| `tests/bases_api.rs` | integration coverage for both endpoints |
| `ui/src/api/schema.d.ts` | regenerated |
| `ui/src/components/bases/operator-labels.ts` | `OPERATOR_LABELS`, `VALUELESS_OPERATORS` (moved out of `FilterComparisonEditor.tsx`) |
| `ui/src/components/bases/view-overrides.ts` | override state type + pure transitions, filter composition, `applyOverridesToView`, `definitionPayload` |
| `ui/src/components/bases/quick-filters.ts` | `quickFilterType`, `quickFiltersForCell`, `DATE_PRESETS`, `headerFilterPresets` |
| `ui/src/components/bases/useViewOverrides.ts` | keyed override state hook |
| `ui/src/components/bases/useRowActions.ts` | open-in-new-tab, copy, duplicate, archive |
| `ui/src/components/bases/useBaseTableController.ts` | wires overrides + row actions + save-to-view into the model |
| `ui/src/components/bases/BaseHeaderMenu.tsx` | column header wrapper + menu |
| `ui/src/components/bases/BaseRowMenu.tsx` | cell context menu, `⋯` row button, shared row items |
| `ui/src/components/bases/ViewOverridesStrip.tsx` | chips, Clear, Save to view, conflict/error text |
| `ui/src/components/bases/ArchiveRowDialog.tsx` | confirm dialog |
| `ui/src/components/bases/BaseTableView.tsx` | wiring: hidden columns, effective grouping, menus, strip, dialog, focus restoration |
| `ui/src/api/bases.ts` | `ViewOverrides.filter/groupBy`, `BaseViewDefinition` type |
| `ui/src/components/bases/embed-query.ts` | `BaseEmbedConfig.groupBy` → body + identity |
| `ui/src/store/workspace.ts` | `OpenTabTarget.mode: "new"` |
| `ui/src/docs/content/bases.mdx` | documentation |

---

### Task 1: Server — group override and standalone filter/group parameters

**Files:**
- Modify: `src/vault/query.rs` (around line 1095, `evaluate_grouped`)
- Modify: `src/vault/base_embed.rs` (`EmbedOverrides`, `composed_query_spec`, `validate_embed_overrides`, `validate_embed_window`, tests module)
- Modify: `src/api/bases.rs` (`ViewParams` ~186, `BaseViewEvaluateRequest` ~210, `prepare_embedded_evaluation` ~236, `query_spec` ~355, `evaluate_view` ~662, utoipa params, tests module ~799)
- Test: `tests/bases_api.rs`
- Regenerate: `ui/src/api/schema.d.ts`

**Interfaces:**
- Produces (Rust): `pub enum GroupOverride { Flat, By(String) }`, `pub fn group_override(raw: Option<&str>) -> Option<GroupOverride>`, `EmbedOverrides { filter, sort, limit, group_by: Option<&str> }`, `composed_query_spec(base, view, filter, sort, limit, group_by: Option<GroupOverride>)`, `validate_embed_window(view, group_by: Option<&GroupOverride>, offset)`.
- Produces (wire): GET `/api/vault/bases/{slug}/views/{view}?filter=<json>&group_by=<field|"">`; POST body `BaseViewEvaluateRequest.group_by?: string | null`. Both return `400 { detail: { code: "invalid_embed_query", diagnostics: [{ field, filter_path, message, scope }] } }` on bad overrides.

- [ ] **Step 1: Write the failing unit tests in `src/vault/base_embed.rs`**

Append inside the existing `mod tests` (after `fn view()`), using the existing helpers `base()`, `cmp`, `view()`, `assert_one_error`:

```rust
    #[test]
    fn composed_query_applies_group_override() {
        let base = base();
        let view = view(); // grouped by `status`

        let inherited = composed_query_spec(&base, &view, None, None, None, None);
        assert_eq!(inherited.group_by.as_deref(), Some("status"));

        let flat = composed_query_spec(&base, &view, None, None, None, Some(GroupOverride::Flat));
        assert_eq!(flat.group_by, None);

        let by_text = composed_query_spec(
            &base,
            &view,
            None,
            None,
            None,
            Some(GroupOverride::By("text".into())),
        );
        assert_eq!(by_text.group_by.as_deref(), Some("text"));
    }

    #[test]
    fn group_override_parses_the_empty_sentinel() {
        assert_eq!(group_override(None), None);
        assert_eq!(group_override(Some("")), Some(GroupOverride::Flat));
        assert_eq!(
            group_override(Some("status")),
            Some(GroupOverride::By("status".into()))
        );
    }

    fn overrides_with_group(group_by: Option<&str>) -> EmbedOverrides<'_> {
        EmbedOverrides {
            filter: None,
            sort: None,
            limit: None,
            group_by,
        }
    }

    #[test]
    fn validate_group_override_accepts_groupable_fields_and_the_sentinel() {
        let base = base();
        for accepted in [Some(""), Some("status"), Some("text"), Some("due"), Some("kind"), None] {
            assert_eq!(
                validate_embed_overrides(&base, overrides_with_group(accepted)),
                Ok(()),
                "{accepted:?}"
            );
        }
    }

    #[test]
    fn validate_group_override_rejects_ungroupable_and_unknown_fields() {
        let base = base();
        assert_one_error(
            validate_embed_overrides(&base, overrides_with_group(Some("rating"))),
            Some("group_by"),
            None,
            "field `rating` cannot group",
        );
        assert_one_error(
            validate_embed_overrides(&base, overrides_with_group(Some("tags"))),
            Some("group_by"),
            None,
            "field `tags` cannot group",
        );
        assert_one_error(
            validate_embed_overrides(&base, overrides_with_group(Some("missing"))),
            Some("group_by"),
            None,
            "unknown field `missing`",
        );
    }

    #[test]
    fn window_validation_uses_the_effective_grouping() {
        let grouped = view();
        let mut flat = view();
        flat.group_by = None;

        assert!(validate_embed_window(&grouped, None, 5).is_err());
        assert_eq!(validate_embed_window(&grouped, Some(&GroupOverride::Flat), 5), Ok(()));
        assert!(
            validate_embed_window(&flat, Some(&GroupOverride::By("status".into())), 5).is_err()
        );
        assert_eq!(validate_embed_window(&flat, None, 5), Ok(()));
    }
```

If `assert_one_error` has a different signature than `(result, field, filter_path, message)`, read it (it is defined near the other helpers around line 560) and adapt the calls — do not change the helper. If `EmbedValidationDiagnostic` does not already derive `PartialEq`, the `assert_eq!(…, Ok(()))` calls need it (it does: `#[derive(Debug, Clone, PartialEq, Eq)]`). `GroupOverride` must derive `Debug, Clone, PartialEq, Eq`.

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `cargo test --lib base_embed::tests 2>&1 | tail -20`
Expected: compile errors (`GroupOverride`, `group_override` not found; wrong arity for `composed_query_spec` / `validate_embed_window`).

- [ ] **Step 3: Implement `is_groupable` in `src/vault/query.rs`**

Add next to `ResolvedField` (search for `pub enum ResolvedField`):

```rust
/// Whether a resolved field may be a `group_by` key: any system field backed
/// by a `pages` column, or a declared property of a scalar, comparable type.
pub(crate) fn is_groupable(resolved: &ResolvedField) -> bool {
    match resolved {
        ResolvedField::Sys(sys) => sys.column().is_some(),
        ResolvedField::Prop { ty, .. } => matches!(
            ty,
            PropertyType::Select
                | PropertyType::Text
                | PropertyType::Bool
                | PropertyType::Date
                | PropertyType::Datetime
                | PropertyType::Url
        ),
    }
}
```

Then rewrite the resolution at the top of `evaluate_grouped` (currently a `match resolve_field(group_key, ctx)?` with an inner `match ty`) to:

```rust
    let resolved = resolve_field(group_key, ctx)?;
    if !is_groupable(&resolved) {
        return Err(QueryError::Ungroupable(group_key.to_string()));
    }
    let group_column = match resolved {
        ResolvedField::Sys(sys) => GroupColumn::System(
            sys.column()
                .expect("is_groupable admits only column-backed system fields"),
        ),
        ResolvedField::Prop { key, ty } => GroupColumn::Property {
            key,
            column: typed_column(ty),
        },
    };
```

(`SysField` is `Copy`; if `sys.column()` on a reference does not compile, write `(*sys).column()`.)

- [ ] **Step 4: Implement the override in `src/vault/base_embed.rs`**

1. Add after `EmbedOverrides`:

```rust
/// A request-time replacement for a saved view's `group_by`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupOverride {
    /// Evaluate the view flat even when it declares a `group_by`.
    Flat,
    /// Group by this field instead of the view's own key.
    By(String),
}

/// Parse the wire form: absent keeps the view's grouping, the empty string
/// asks for a flat result, anything else names the group key.
pub fn group_override(raw: Option<&str>) -> Option<GroupOverride> {
    match raw {
        None => None,
        Some("") => Some(GroupOverride::Flat),
        Some(field) => Some(GroupOverride::By(field.to_owned())),
    }
}
```

2. Add `pub group_by: Option<&'a str>` to `EmbedOverrides` (raw wire value, so validation can see the sentinel).

3. Change `composed_query_spec` to take a sixth parameter `group_by: Option<GroupOverride>` and build:

```rust
        group_by: match group_by {
            Some(GroupOverride::Flat) => None,
            Some(GroupOverride::By(field)) => Some(field),
            None => view.group_by.clone(),
        },
```

Update the doc comment: "A present group override replaces the saved `group_by`; `Flat` evaluates the view ungrouped."

4. In `validate_embed_overrides`, after the sort branch:

```rust
    if let Some(group_by) = overrides.group_by
        && !group_by.is_empty()
    {
        validate_group_semantics(base, group_by, &mut diagnostics);
    }
```

and add:

```rust
fn validate_group_semantics(
    base: &BaseDefinition,
    group_by: &str,
    diagnostics: &mut Vec<EmbedValidationDiagnostic>,
) {
    match resolve_declared_field(base, group_by) {
        Err(message) => diagnostics.push(diagnostic(Some("group_by"), None, message)),
        Ok(resolved) if !super::query::is_groupable(&resolved) => diagnostics.push(diagnostic(
            Some("group_by"),
            None,
            format!("field `{group_by}` cannot group"),
        )),
        Ok(_) => {}
    }
}
```

(`resolve_declared_field` returns `Result<ResolvedField, String>` — check its error strings match the test: `unknown field \`missing\``.)

5. Change `validate_embed_window` to `(view: &ViewDefinition, group_by: Option<&GroupOverride>, offset: u32)`:

```rust
    let grouped = match group_by {
        Some(GroupOverride::Flat) => false,
        Some(GroupOverride::By(_)) => true,
        None => view.group_by.is_some(),
    };
    if offset > 0 && grouped {
        return Err(vec![diagnostic(
            Some("offset"),
            None,
            "offset is not supported for a grouped view",
        )]);
    }
    Ok(())
```

6. Fix every existing caller: `grep -rn "composed_query_spec(\|validate_embed_window(\|EmbedOverrides {" src/` — pass `None` for the new argument / field where no override exists (including the tests in this module that construct `EmbedOverrides`).

- [ ] **Step 5: Run the unit tests**

Run: `cargo test --lib base_embed 2>&1 | tail -20`
Expected: all pass.

- [ ] **Step 6: Write the failing integration tests in `tests/bases_api.rs`**

Add a seed helper after `seed_with_unevaluable_base`:

```rust
fn seed_with_grouped_shelf(root: &Path) {
    seed(root);
    fs::write(
        root.join("bases/shelf.base.toml"),
        r#"
name = "Shelf"

[filter]
all = [ { field = "kind", op = "eq", value = "BOOK" } ]

[properties]
status = { type = "select", options = ["queued", "reading", "finished"] }
rating = { type = "number" }

[[views]]
name = "ByStatus"
layout = "table"
group_by = "status"
columns = ["title", "rating"]
"#,
    )
    .unwrap();
}
```

Add tests after `view_evaluation_honors_view_filter_and_sort`:

```rust
#[tokio::test]
async fn view_evaluation_accepts_a_request_filter() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();

    let filter = serde_json::json!({ "field": "author", "op": "eq", "value": "Le Guin" });
    let res = server
        .get("/api/vault/bases/reading/views/continues")
        .add_query_param("filter", filter.to_string())
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["shape"], "flat");
    assert_eq!(body["total"], 1);
    assert_eq!(body["rows"][0]["path"], "b.md");
}

#[tokio::test]
async fn view_evaluation_rejects_a_malformed_request_filter() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();

    let res = server
        .get("/api/vault/bases/reading/views/continues?filter=not-json")
        .await;
    res.assert_status_bad_request();
    let body: serde_json::Value = res.json();
    assert_eq!(body["detail"]["code"], "invalid_embed_query");
    assert_eq!(body["detail"]["diagnostics"][0]["field"], "filter");
    assert_eq!(
        body["detail"]["diagnostics"][0]["message"],
        "filter is not valid JSON"
    );

    let unknown = serde_json::json!({ "field": "missing", "op": "eq", "value": 1 });
    let res = server
        .get("/api/vault/bases/reading/views/continues")
        .add_query_param("filter", unknown.to_string())
        .await;
    res.assert_status_bad_request();
    let body: serde_json::Value = res.json();
    assert_eq!(body["detail"]["diagnostics"][0]["field"], "missing");
}

#[tokio::test]
async fn view_evaluation_honors_a_group_override() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_with_grouped_shelf)
        .build()
        .into_server_and_temp();

    // Flat view grouped on request.
    let res = server
        .get("/api/vault/bases/reading/views/continues?group_by=author")
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["shape"], "grouped");
    assert_eq!(body["groups"].as_array().unwrap().len(), 2);

    // Grouped view flattened on request.
    let res = server
        .get("/api/vault/bases/shelf/views/ByStatus?group_by=")
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["shape"], "flat");
    assert_eq!(body["total"], 3);

    // Absent keeps the view's grouping.
    let res = server.get("/api/vault/bases/shelf/views/ByStatus").await;
    res.assert_status_ok();
    assert_eq!(res.json::<serde_json::Value>()["shape"], "grouped");

    // Ungroupable key.
    let res = server
        .get("/api/vault/bases/shelf/views/ByStatus?group_by=rating")
        .await;
    res.assert_status_bad_request();
    let body: serde_json::Value = res.json();
    assert_eq!(body["detail"]["code"], "invalid_embed_query");
    assert_eq!(body["detail"]["diagnostics"][0]["field"], "group_by");
    assert_eq!(
        body["detail"]["diagnostics"][0]["message"],
        "field `rating` cannot group"
    );
}

#[tokio::test]
async fn embedded_evaluation_honors_a_group_override() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_with_grouped_shelf)
        .build()
        .into_server_and_temp();

    let res = server
        .post("/api/vault/bases/reading/views/Continues/evaluate")
        .json(&serde_json::json!({ "group_by": "author", "limit": 10 }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["output"]["shape"], "grouped");

    let res = server
        .post("/api/vault/bases/shelf/views/ByStatus/evaluate")
        .json(&serde_json::json!({ "group_by": "", "limit": 10, "offset": 0 }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["output"]["shape"], "flat");
    assert_eq!(body["output"]["total"], 3);

    // A grouped override refuses a window offset, exactly like a grouped view.
    let res = server
        .post("/api/vault/bases/reading/views/Continues/evaluate")
        .json(&serde_json::json!({ "group_by": "author", "limit": 10, "offset": 10 }))
        .await;
    res.assert_status_bad_request();
    let body: serde_json::Value = res.json();
    assert_eq!(body["detail"]["diagnostics"][0]["field"], "offset");
}
```

`ApiFixture` and `seed` are already in this file. `add_query_param` is axum-test's `TestRequest::add_query_param(key, value)`; if it is missing in the pinned version, build the URL with `urlencoding`-free `format!("…?filter={}", percent_encode)`; the repo already depends on `percent-encoding` — `grep percent tests/*.rs Cargo.toml` — otherwise append via `.add_query_params(serde_json::json!({ "filter": … }))`.

- [ ] **Step 7: Run the integration tests to verify they fail**

Run: `cargo test --test bases_api group_override 2>&1 | tail -20` and `cargo test --test bases_api request_filter 2>&1 | tail -20`
Expected: the filter tests return 200 with unfiltered rows (assertions fail); the group tests fail on `shape`.

- [ ] **Step 8: Implement the API changes in `src/api/bases.rs`**

1. `ViewParams` gains:

```rust
    /// A JSON-encoded filter AND-ed after the base and view filters.
    pub filter: Option<String>,
    /// Replace the view's `group_by` for this request; the empty string
    /// evaluates the view flat.
    pub group_by: Option<String>,
```

2. `BaseViewEvaluateRequest` gains:

```rust
    /// Replace the view's `group_by` for this request; the empty string
    /// evaluates the view flat. Absent keeps the saved grouping.
    pub group_by: Option<String>,
```

3. `query_spec` takes two more parameters, `filter: Option<Filter>` and `group_by: Option<GroupOverride>`, and passes them into `composed_query_spec(base, view, filter, sort, limit, group_by)`; in the `None` view arm compose `filter` with `base.file.filter` the same way (`Filter::All` of the two when both are present) and set `group_by` from `group_by` (`Flat` → `None`, `By(f)` → `Some(f)`). Update the two existing call sites (`Some(0), 0, None, None` at ~line 410 and the preview handler at ~626) with `None, None`.

4. In `evaluate_view`, after resolving `view`:

```rust
    let filter = match params.filter.as_deref() {
        None => None,
        Some(raw) => Some(serde_json::from_str::<Filter>(raw).map_err(|_| {
            invalid_embed_query(vec![EmbedValidationDiagnostic {
                field: Some("filter".to_owned()),
                filter_path: None,
                message: "filter is not valid JSON".to_owned(),
            }])
        })?),
    };
    validate_embed_overrides(
        &base,
        EmbedOverrides {
            filter: filter.as_ref(),
            sort: None,
            limit: None,
            group_by: params.group_by.as_deref(),
        },
    )
    .map_err(invalid_embed_query)?;
    let group_by = group_override(params.group_by.as_deref());

    let spec = query_spec(
        &base,
        Some(&view),
        params.limit,
        params.offset.unwrap_or(0),
        params.sort.as_deref(),
        params.dir.as_deref(),
        filter,
        group_by,
    );
```

Import `EmbedOverrides`, `EmbedValidationDiagnostic`, `GroupOverride`, `group_override`, `validate_embed_overrides` from `crate::vault::base_embed` (some are already imported). Add the two utoipa params:

```rust
        ("filter" = Option<String>, Query, description = "JSON-encoded filter AND-ed after the base and view filters"),
        ("group_by" = Option<String>, Query, description = "Group-by override; empty string evaluates the view flat")
```

and add `(status = 400, body = ApiError)` to the responses.

5. In `prepare_embedded_evaluation`: pass `group_by: request.group_by.as_deref()` in `EmbedOverrides`; compute `let group_by = group_override(request.group_by.as_deref());`; call `validate_embed_window(&view, group_by.as_ref(), offset)`; pass `group_by` as the last argument of `composed_query_spec`.

6. Update the test-module constructors of `BaseViewEvaluateRequest` (around line 799 onward) with `group_by: None`.

- [ ] **Step 9: Run the whole Rust gate**

Run: `cargo fmt && cargo clippy --all-targets -- -D warnings 2>&1 | tail -5 && cargo test 2>&1 | grep -E "^test result|FAILED|panicked" | head -20`
Expected: clippy clean; every `test result:` line reports `0 failed`.

- [ ] **Step 10: Regenerate the OpenAPI schema**

Run: `cargo run -q --example openapi > target/openapi.json && (cd ui && bun run openapi:file) && git diff --stat -- ui/src/api/schema.d.ts`
Expected: the diff adds `filter?`/`group_by?` to the GET's `query` parameters and `group_by?: string | null` to `BaseViewEvaluateRequest`. Then `cd ui && bun run typecheck` must still pass.

- [ ] **Step 11: Commit**

```bash
git add src/vault/query.rs src/vault/base_embed.rs src/api/bases.rs tests/bases_api.rs ui/src/api/schema.d.ts
git commit -m "feat(bases): request-time filter and group_by overrides for saved views"
```

---

### Task 2: UI model — operator labels, override state, quick-filter derivation

**Files:**
- Create: `ui/src/components/bases/operator-labels.ts`
- Modify: `ui/src/components/bases/FilterComparisonEditor.tsx` (lines 30-61: delete the two consts, import them)
- Create: `ui/src/components/bases/view-overrides.ts`
- Create: `ui/src/components/bases/quick-filters.ts`
- Modify: `ui/src/api/bases.ts` (add `export type BaseViewDefinition = components["schemas"]["ViewDefinition"];` and `export type BaseFilePayload = components["schemas"]["BaseFilePayload"];` next to the other type exports if absent)
- Test: `ui/src/components/bases/__tests__/view-overrides.test.ts`, `ui/src/components/bases/__tests__/quick-filters.test.ts`

**Interfaces:**
- Produces: everything exported below; later tasks import from these modules by these exact names.

- [ ] **Step 1: Move the operator labels**

Create `ui/src/components/bases/operator-labels.ts`:

```ts
import type { FilterOp } from "#/api/bases";

export const VALUELESS_OPERATORS: Partial<Record<FilterOp, true>> = {
  is_empty: true,
  not_empty: true,
  is_today: true,
  is_this_week: true,
  is_past_week: true,
  is_next_week: true,
  is_this_month: true,
};

export const OPERATOR_LABELS: Record<FilterOp, string> = {
  eq: "is",
  ne: "is not",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  in: "is any of",
  links_to: "links to",
  is_empty: "is empty",
  not_empty: "is not empty",
  is_today: "is today",
  is_this_week: "is this week",
  is_past_week: "is in the past week",
  is_next_week: "is in the next week",
  is_this_month: "is this month",
};
```

In `FilterComparisonEditor.tsx` delete the two local consts and add `import { OPERATOR_LABELS, VALUELESS_OPERATORS } from "./operator-labels";`. Run `cd ui && bun run test src/components/bases` to confirm nothing changed.

- [ ] **Step 2: Write the failing tests for `view-overrides.ts`**

`ui/src/components/bases/__tests__/view-overrides.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { BaseDetailResponse, BaseViewDefinition } from "#/api/bases";
import {
  applyOverridesToView,
  composeQuickFilters,
  definitionPayload,
  EMPTY_OVERRIDES,
  groupOverrideParam,
  hasOverrides,
  quickFilterIdentity,
  withGroup,
  withHiddenColumn,
  withoutHiddenColumns,
  withoutQuickFilter,
  withQuickFilter,
  type QuickFilter,
} from "#/components/bases/view-overrides";

const reading: QuickFilter = {
  field: "status",
  op: "eq",
  value: "reading",
  label: "status is reading",
};
const today: QuickFilter = { field: "due", op: "is_today", label: "due is today" };

describe("override state transitions", () => {
  it("adds a quick filter once and removes it by identity", () => {
    const once = withQuickFilter(EMPTY_OVERRIDES, reading);
    const twice = withQuickFilter(once, { ...reading, label: "other label" });
    expect(twice.quickFilters).toHaveLength(1);
    expect(withoutQuickFilter(twice, quickFilterIdentity(reading)).quickFilters).toEqual([]);
  });

  it("tracks group and hidden columns", () => {
    const grouped = withGroup(EMPTY_OVERRIDES, { kind: "by", field: "status" });
    expect(grouped.group).toEqual({ kind: "by", field: "status" });
    expect(withGroup(grouped, undefined).group).toBeUndefined();
    const hidden = withHiddenColumn(withHiddenColumn(EMPTY_OVERRIDES, "author"), "author");
    expect(hidden.hiddenColumns).toEqual(["author"]);
    expect(withoutHiddenColumns(hidden).hiddenColumns).toEqual([]);
  });

  it("reports overrides including a caller-owned sort", () => {
    expect(hasOverrides(EMPTY_OVERRIDES, undefined)).toBe(false);
    expect(hasOverrides(EMPTY_OVERRIDES, [{ field: "author", dir: "asc" }])).toBe(true);
    expect(hasOverrides(withGroup(EMPTY_OVERRIDES, { kind: "flat" }), undefined)).toBe(true);
  });
});

describe("filter composition", () => {
  it("returns the base filter untouched without quick filters", () => {
    const base = { field: "kind", op: "eq", value: "BOOK" } as const;
    expect(composeQuickFilters(base, [])).toEqual(base);
    expect(composeQuickFilters(undefined, [])).toBeUndefined();
  });

  it("sends a lone quick filter bare and conjoins several", () => {
    expect(composeQuickFilters(undefined, [today])).toEqual({ field: "due", op: "is_today" });
    expect(composeQuickFilters(undefined, [reading, today])).toEqual({
      all: [
        { field: "status", op: "eq", value: "reading" },
        { field: "due", op: "is_today" },
      ],
    });
  });

  it("flattens into an existing all-group", () => {
    expect(
      composeQuickFilters({ all: [{ field: "kind", op: "eq", value: "BOOK" }] }, [reading]),
    ).toEqual({
      all: [
        { field: "kind", op: "eq", value: "BOOK" },
        { field: "status", op: "eq", value: "reading" },
      ],
    });
  });

  it("maps the group override to the wire sentinel", () => {
    expect(groupOverrideParam(undefined)).toBeUndefined();
    expect(groupOverrideParam({ kind: "flat" })).toBe("");
    expect(groupOverrideParam({ kind: "by", field: "status" })).toBe("status");
  });
});

describe("applyOverridesToView", () => {
  const view: BaseViewDefinition = {
    name: "Continues",
    layout: "table",
    filter: { field: "status", op: "eq", value: "reading" },
    sort: [{ field: "started", dir: "desc" }],
    columns: ["title", "author", "rating"],
  };

  it("leaves the view alone without overrides", () => {
    expect(applyOverridesToView(view, EMPTY_OVERRIDES, undefined, view.columns ?? [])).toEqual(view);
  });

  it("conjoins quick filters, applies grouping, sort and hidden columns", () => {
    const state = withHiddenColumn(
      withGroup(withQuickFilter(EMPTY_OVERRIDES, today), { kind: "by", field: "status" }),
      "rating",
    );
    expect(
      applyOverridesToView(view, state, [{ field: "author", dir: "asc" }], ["title", "author", "rating"]),
    ).toEqual({
      name: "Continues",
      layout: "table",
      filter: {
        all: [
          { field: "status", op: "eq", value: "reading" },
          { field: "due", op: "is_today" },
        ],
      },
      sort: [{ field: "author", dir: "asc" }],
      group_by: "status",
      columns: ["title", "author"],
    });
  });

  it("removes group_by for a flat override", () => {
    const grouped = { ...view, group_by: "status" };
    const next = applyOverridesToView(grouped, withGroup(EMPTY_OVERRIDES, { kind: "flat" }), undefined, []);
    expect("group_by" in next).toBe(false);
  });
});

describe("definitionPayload", () => {
  it("strips response-only fields and swaps the named view", () => {
    const detail: BaseDetailResponse = {
      slug: "reading",
      revision: "r1",
      name: "Reading Log",
      description: "Books",
      properties: [{ key: "status", definition: { type: "select" } }],
      views: [
        { name: "Continues", layout: "table", columns: ["title"] },
        { name: "Shelf", layout: "table", columns: ["title"] },
      ],
      diagnostics: [],
      member_creation: [],
    };
    const payload = definitionPayload(detail, {
      name: "Shelf",
      layout: "table",
      columns: ["title", "status"],
    });
    expect(payload).toEqual({
      name: "Reading Log",
      description: "Books",
      properties: [{ key: "status", definition: { type: "select" } }],
      views: [
        { name: "Continues", layout: "table", columns: ["title"] },
        { name: "Shelf", layout: "table", columns: ["title", "status"] },
      ],
    });
    expect("slug" in payload).toBe(false);
    expect("revision" in payload).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd ui && bun run test src/components/bases/__tests__/view-overrides.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `view-overrides.ts`**

```ts
import type {
  BaseDetailResponse,
  BaseFilePayload,
  BaseFilter,
  BaseViewDefinition,
  FilterOp,
  SortKey,
} from "#/api/bases";
import { asciiCaseFold } from "./local-validation";

export type GroupOverride = { kind: "flat" } | { kind: "by"; field: string };

export interface QuickFilter {
  field: string;
  op: FilterOp;
  value?: unknown;
  /** Menu item and chip text, e.g. `status is reading`. */
  label: string;
}

export interface ViewOverridesState {
  quickFilters: QuickFilter[];
  group: GroupOverride | undefined;
  hiddenColumns: string[];
}

export const EMPTY_OVERRIDES: ViewOverridesState = {
  quickFilters: [],
  group: undefined,
  hiddenColumns: [],
};

export function quickFilterIdentity(filter: QuickFilter): string {
  return JSON.stringify({
    field: filter.field,
    op: filter.op,
    value: filter.value ?? null,
  });
}

export function withQuickFilter(
  state: ViewOverridesState,
  filter: QuickFilter,
): ViewOverridesState {
  const identity = quickFilterIdentity(filter);
  if (state.quickFilters.some((f) => quickFilterIdentity(f) === identity)) return state;
  return { ...state, quickFilters: [...state.quickFilters, filter] };
}

export function withoutQuickFilter(
  state: ViewOverridesState,
  identity: string,
): ViewOverridesState {
  return {
    ...state,
    quickFilters: state.quickFilters.filter((f) => quickFilterIdentity(f) !== identity),
  };
}

export function withGroup(
  state: ViewOverridesState,
  group: GroupOverride | undefined,
): ViewOverridesState {
  return { ...state, group };
}

export function withHiddenColumn(
  state: ViewOverridesState,
  column: string,
): ViewOverridesState {
  if (state.hiddenColumns.includes(column)) return state;
  return { ...state, hiddenColumns: [...state.hiddenColumns, column] };
}

export function withoutHiddenColumns(state: ViewOverridesState): ViewOverridesState {
  return { ...state, hiddenColumns: [] };
}

export function hasOverrides(
  state: ViewOverridesState,
  sort: SortKey[] | undefined,
): boolean {
  return (
    state.quickFilters.length > 0 ||
    state.group !== undefined ||
    state.hiddenColumns.length > 0 ||
    (sort !== undefined && sort.length > 0)
  );
}

export function toFilter(filter: QuickFilter): BaseFilter {
  return filter.value === undefined
    ? { field: filter.field, op: filter.op }
    : { field: filter.field, op: filter.op, value: filter.value };
}

function conjuncts(filter: BaseFilter | undefined): BaseFilter[] {
  if (filter === undefined) return [];
  return "all" in filter ? filter.all : [filter];
}

/** AND the quick filters after `base`; a lone conjunct stays bare. */
export function composeQuickFilters(
  base: BaseFilter | undefined,
  quick: QuickFilter[],
): BaseFilter | undefined {
  if (quick.length === 0) return base;
  const all = [...conjuncts(base), ...quick.map(toFilter)];
  return all.length === 1 ? all[0] : { all };
}

export function groupOverrideParam(
  group: GroupOverride | undefined,
): string | undefined {
  if (group === undefined) return undefined;
  return group.kind === "flat" ? "" : group.field;
}

/** Materialise the overrides into the saved view definition. */
export function applyOverridesToView(
  view: BaseViewDefinition,
  state: ViewOverridesState,
  sort: SortKey[] | undefined,
  renderedColumns: string[],
): BaseViewDefinition {
  const next: BaseViewDefinition = { ...view };
  if (state.quickFilters.length > 0) {
    next.filter = composeQuickFilters(view.filter ?? undefined, state.quickFilters);
  }
  if (state.group?.kind === "by") next.group_by = state.group.field;
  if (state.group?.kind === "flat") delete next.group_by;
  if (sort !== undefined && sort.length > 0) next.sort = sort;
  if (state.hiddenColumns.length > 0) {
    next.columns = renderedColumns.filter((c) => !state.hiddenColumns.includes(c));
  }
  return next;
}

/** The PUT body's `definition`: the detail response minus response-only
 * fields, with `view` replacing the saved view of the same name. */
export function definitionPayload(
  detail: BaseDetailResponse,
  view: BaseViewDefinition,
): BaseFilePayload {
  const target = asciiCaseFold(view.name);
  return {
    name: detail.name,
    ...(detail.description == null ? {} : { description: detail.description }),
    ...(detail.title_template == null ? {} : { title_template: detail.title_template }),
    ...(detail.filter == null ? {} : { filter: detail.filter }),
    ...(detail.preview === undefined || detail.preview.length === 0
      ? {}
      : { preview: detail.preview }),
    properties: detail.properties ?? [],
    views: (detail.views ?? []).map((candidate) =>
      asciiCaseFold(candidate.name) === target ? view : candidate,
    ),
  };
}
```

If `BaseFilePayload.properties` is optional in the schema, keep `properties: detail.properties ?? []` (the server defaults it). Check the schema's exact optionality with `grep -n "BaseFilePayload: {" -A12 ui/src/api/schema.d.ts` and adapt the spread so the test's `toEqual` passes — the test expects no `title_template`/`filter`/`preview` keys when absent.

- [ ] **Step 5: Run the tests**

Run: `cd ui && bun run test src/components/bases/__tests__/view-overrides.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing tests for `quick-filters.ts`**

`ui/src/components/bases/__tests__/quick-filters.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DATE_PRESETS,
  datePresetFilter,
  headerFilterPresets,
  HEADER_OPTION_CAP,
  isDateLike,
  quickFiltersForCell,
  quickFilterType,
} from "#/components/bases/quick-filters";

describe("quickFilterType", () => {
  it("uses the declared type and maps system columns", () => {
    expect(quickFilterType("status", { type: "select" })).toBe("select");
    expect(quickFilterType("kind", undefined)).toBe("system-scalar");
    expect(quickFilterType("project", undefined)).toBe("system-scalar");
    expect(quickFilterType("tags", undefined)).toBe("system-multi");
    expect(quickFilterType("created_at", undefined)).toBe("datetime");
    expect(quickFilterType("journal_date", undefined)).toBe("date");
    for (const column of ["title", "path", "id", "body", "word_count", "unknown"]) {
      expect(quickFilterType(column, undefined)).toBeUndefined();
    }
  });
});

describe("quickFiltersForCell", () => {
  it("offers is-empty for empty values of any filterable type", () => {
    expect(quickFiltersForCell("status", "select", null, "Status")).toEqual([
      { field: "status", op: "is_empty", label: "Status is empty" },
    ]);
    expect(quickFiltersForCell("tags", "system-multi", [], "Tags")).toEqual([
      { field: "tags", op: "is_empty", label: "Tags is empty" },
    ]);
  });

  it("derives equality for scalars, quoting text", () => {
    expect(quickFiltersForCell("status", "select", "reading", "Status")).toEqual([
      { field: "status", op: "eq", value: "reading", label: "Status is reading" },
    ]);
    expect(quickFiltersForCell("rating", "number", 4, "Rating")).toEqual([
      { field: "rating", op: "eq", value: 4, label: "Rating is 4" },
    ]);
    expect(quickFiltersForCell("author", "text", "Wolfe", "Author")).toEqual([
      { field: "author", op: "eq", value: "Wolfe", label: 'Author is "Wolfe"' },
    ]);
    expect(quickFiltersForCell("kind", "system-scalar", "BOOK", "Kind")).toEqual([
      { field: "kind", op: "eq", value: "BOOK", label: "Kind is BOOK" },
    ]);
  });

  it("derives checked and unchecked for booleans", () => {
    expect(quickFiltersForCell("done", "bool", true, "Done")).toEqual([
      { field: "done", op: "eq", value: true, label: "Done is checked" },
    ]);
    expect(quickFiltersForCell("done", "bool", false, "Done")).toEqual([
      { field: "done", op: "eq", value: false, label: "Done is unchecked" },
    ]);
  });

  it("derives one membership filter per element", () => {
    expect(quickFiltersForCell("themes", "multi_select", ["a", "b"], "Themes")).toEqual([
      { field: "themes", op: "contains", value: "a", label: "Themes has a" },
      { field: "themes", op: "contains", value: "b", label: "Themes has b" },
    ]);
    expect(quickFiltersForCell("series", "relation", ["[[Earthsea]]"], "Series")).toEqual([
      { field: "series", op: "links_to", value: "[[Earthsea]]", label: "Series links to [[Earthsea]]" },
    ]);
  });

  it("uses the date face for dates and nothing for datetimes", () => {
    expect(quickFiltersForCell("due", "date", "2026-08-28", "Due")).toEqual([
      { field: "due", op: "eq", value: "2026-08-28", label: "Due is 2026-08-28" },
    ]);
    expect(quickFiltersForCell("created_at", "datetime", "2026-08-28T10:00:00Z", "Created at")).toEqual([]);
  });
});

describe("date presets", () => {
  it("lists the five relative operators", () => {
    expect(DATE_PRESETS.map((p) => p.op)).toEqual([
      "is_today",
      "is_this_week",
      "is_past_week",
      "is_next_week",
      "is_this_month",
    ]);
    expect(DATE_PRESETS.map((p) => p.label)).toEqual([
      "Today",
      "This week",
      "Past week",
      "Next week",
      "This month",
    ]);
    expect(isDateLike("date")).toBe(true);
    expect(isDateLike("datetime")).toBe(true);
    expect(isDateLike("text")).toBe(false);
    expect(datePresetFilter("due", "Due", "is_past_week")).toEqual({
      field: "due",
      op: "is_past_week",
      label: "Due is in the past week",
    });
  });
});

describe("headerFilterPresets", () => {
  it("offers emptiness for filterable columns and nothing for numbers", () => {
    expect(headerFilterPresets("author", "text", undefined, "Author").map((f) => f.label)).toEqual([
      "Author is empty",
      "Author is not empty",
    ]);
    expect(headerFilterPresets("rating", "number", undefined, "Rating")).toEqual([]);
  });

  it("adds checked/unchecked, date presets and select options", () => {
    expect(headerFilterPresets("done", "bool", undefined, "Done").map((f) => f.label)).toEqual([
      "Done is checked",
      "Done is unchecked",
      "Done is empty",
      "Done is not empty",
    ]);
    expect(headerFilterPresets("due", "date", undefined, "Due").map((f) => f.label)).toEqual([
      "Due is today",
      "Due is this week",
      "Due is in the past week",
      "Due is in the next week",
      "Due is this month",
      "Due is empty",
      "Due is not empty",
    ]);
    expect(
      headerFilterPresets("status", "select", { type: "select", options: ["queued", "reading"] }, "Status").map(
        (f) => f.label,
      ),
    ).toEqual(["Status is queued", "Status is reading", "Status is empty", "Status is not empty"]);
    expect(
      headerFilterPresets("themes", "multi_select", { type: "multi_select", options: ["a"] }, "Themes").map(
        (f) => f.label,
      ),
    ).toEqual(["Themes has a", "Themes is empty", "Themes is not empty"]);
  });

  it("caps the option list", () => {
    const options = Array.from({ length: HEADER_OPTION_CAP + 3 }, (_, i) => `o${i}`);
    const presets = headerFilterPresets("status", "select", { type: "select", options }, "Status");
    expect(presets.filter((f) => f.op === "eq")).toHaveLength(HEADER_OPTION_CAP);
  });
});
```

- [ ] **Step 7: Run to verify failure**

Run: `cd ui && bun run test src/components/bases/__tests__/quick-filters.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement `quick-filters.ts`**

```ts
import type { FilterOp, PropertyDefinition, PropertyType } from "#/api/bases";
import type { CellValue } from "./cells/types";
import { OPERATOR_LABELS } from "./operator-labels";
import type { QuickFilter } from "./view-overrides";

export type QuickFilterType = PropertyType | "system-scalar" | "system-multi";

/** The filterable type of a rendered column, or undefined for columns that
 * take no quick filter (title, path, id, body, word_count, undeclared). */
export function quickFilterType(
  column: string,
  definition: PropertyDefinition | undefined,
): QuickFilterType | undefined {
  if (definition) return definition.type;
  switch (column) {
    case "kind":
    case "project":
      return "system-scalar";
    case "tags":
    case "aliases":
      return "system-multi";
    case "created_at":
    case "updated_at":
      return "datetime";
    case "journal_date":
      return "date";
    default:
      return undefined;
  }
}

export function isDateLike(type: QuickFilterType | undefined): boolean {
  return type === "date" || type === "datetime";
}

function isEmptyValue(value: CellValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function emptiness(field: string, label: string, op: "is_empty" | "not_empty"): QuickFilter {
  return { field, op, label: `${label} ${OPERATOR_LABELS[op]}` };
}

function checked(field: string, label: string, value: boolean): QuickFilter {
  return { field, op: "eq", value, label: `${label} is ${value ? "checked" : "unchecked"}` };
}

function membership(
  field: string,
  label: string,
  op: "contains" | "links_to",
  value: unknown,
): QuickFilter {
  const verb = op === "contains" ? "has" : OPERATOR_LABELS.links_to;
  return { field, op, value, label: `${label} ${verb} ${String(value)}` };
}

/** The value-derived filters for one cell (spec table "Quick-filter derivation"). */
export function quickFiltersForCell(
  field: string,
  type: QuickFilterType,
  value: CellValue | undefined,
  label: string,
): QuickFilter[] {
  if (type === "number" && isEmptyValue(value)) return [];
  if (isEmptyValue(value)) return [emptiness(field, label, "is_empty")];
  switch (type) {
    case "bool":
      return typeof value === "boolean" ? [checked(field, label, value)] : [];
    case "select":
    case "number":
    case "system-scalar":
      return Array.isArray(value) || typeof value === "object"
        ? []
        : [{ field, op: "eq", value, label: `${label} is ${String(value)}` }];
    case "text":
    case "url":
      return typeof value === "string"
        ? [{ field, op: "eq", value, label: `${label} is "${value}"` }]
        : [];
    case "multi_select":
    case "system-multi":
      return Array.isArray(value)
        ? value.map((element) => membership(field, label, "contains", element))
        : [];
    case "relation":
      return Array.isArray(value)
        ? value.map((element) => membership(field, label, "links_to", element))
        : [];
    case "date": {
      if (typeof value !== "string") return [];
      const face = value.slice(0, 10);
      return [{ field, op: "eq", value: face, label: `${label} is ${face}` }];
    }
    case "datetime":
      return [];
  }
}

export const DATE_PRESETS: readonly { op: FilterOp; label: string }[] = [
  { op: "is_today", label: "Today" },
  { op: "is_this_week", label: "This week" },
  { op: "is_past_week", label: "Past week" },
  { op: "is_next_week", label: "Next week" },
  { op: "is_this_month", label: "This month" },
];

export function datePresetFilter(field: string, label: string, op: FilterOp): QuickFilter {
  return { field, op, label: `${label} ${OPERATOR_LABELS[op]}` };
}

export const HEADER_OPTION_CAP = 12;

/** The header menu's Filter ▸ presets (spec "headerFilterPresets"). */
export function headerFilterPresets(
  field: string,
  type: QuickFilterType | undefined,
  definition: PropertyDefinition | undefined,
  label: string,
): QuickFilter[] {
  if (type === undefined || type === "number") return [];
  const presets: QuickFilter[] = [];
  if (type === "bool") {
    presets.push(checked(field, label, true), checked(field, label, false));
  }
  if (isDateLike(type)) {
    for (const preset of DATE_PRESETS) presets.push(datePresetFilter(field, label, preset.op));
  }
  if (type === "select" || type === "multi_select") {
    const options = (definition?.options ?? []).slice(0, HEADER_OPTION_CAP);
    for (const option of options) {
      presets.push(
        type === "select"
          ? { field, op: "eq", value: option, label: `${label} is ${option}` }
          : membership(field, label, "contains", option),
      );
    }
  }
  presets.push(emptiness(field, label, "is_empty"), emptiness(field, label, "not_empty"));
  return presets;
}
```

`PropertyDefinition.options` is `string[] | null | undefined` in the schema — keep the `?? []`.

- [ ] **Step 9: Run tests, typecheck, lint**

Run: `cd ui && bun run test src/components/bases && bun run typecheck && bun run lint`
Expected: PASS / clean. Format the new files: `cd ui && bunx biome check --write src/components/bases/operator-labels.ts src/components/bases/view-overrides.ts src/components/bases/quick-filters.ts src/components/bases/FilterComparisonEditor.tsx src/components/bases/__tests__/view-overrides.test.ts src/components/bases/__tests__/quick-filters.test.ts`.

- [ ] **Step 10: Commit**

```bash
git add ui/src/components/bases/operator-labels.ts ui/src/components/bases/view-overrides.ts ui/src/components/bases/quick-filters.ts ui/src/components/bases/FilterComparisonEditor.tsx ui/src/api/bases.ts ui/src/components/bases/__tests__/view-overrides.test.ts ui/src/components/bases/__tests__/quick-filters.test.ts
git commit -m "feat(bases): view override model and quick-filter derivation"
```

---

### Task 3: UI plumbing — request overrides and open-in-new-tab

**Files:**
- Modify: `ui/src/api/bases.ts` (`ViewOverrides`, `useBaseView` ~lines 208-232)
- Modify: `ui/src/components/bases/embed-query.ts` (`BaseEmbedConfig`, `NormalizedEmbedConfig`, `normalizeEmbedConfiguration`, `queryIdentity`, `baseViewEvaluationBody`)
- Modify: `ui/src/store/workspace.ts` (`OpenTabTarget` line 18, `openTab` branch ~line 324)
- Test: `ui/src/components/bases/__tests__/embed-query.test.ts` (exists — extend; if it does not, create it), `ui/src/store/workspace.test.ts` (extend `describe("useWorkspaceStore openTab wiring")`), `ui/src/api/__tests__/bases.test.ts` or the nearest existing `useBaseView` test (search `grep -rln "useBaseView" ui/src --include=*.test.*`)

**Interfaces:**
- Consumes: `GroupOverride`, `groupOverrideParam` from `view-overrides.ts`.
- Produces: `ViewOverrides { sort?, dir?, filter?: BaseFilter, groupBy?: GroupOverride }`; `BaseEmbedConfig.groupBy?: GroupOverride`; `OpenTabTarget.mode?: "new"`.

- [ ] **Step 1: Failing tests — embed query**

Add to the embed-query test file:

```ts
it("carries a group override into the body and the query identity, not the predicate", () => {
  const base = { base: "reading", view: "Continues" };
  const grouped = { ...base, groupBy: { kind: "by", field: "status" } as const };
  const flat = { ...base, groupBy: { kind: "flat" } as const };
  expect(baseViewEvaluationBody(base, { limit: 50, offset: 0 })).toEqual({ limit: 50, offset: 0 });
  expect(baseViewEvaluationBody(grouped, { limit: 50, offset: 0 })).toEqual({
    group_by: "status",
    limit: 50,
    offset: 0,
  });
  expect(baseViewEvaluationBody(flat, { limit: 50, offset: 0 })).toEqual({
    group_by: "",
    limit: 50,
    offset: 0,
  });
  expect(predicateIdentity(grouped)).toBe(predicateIdentity(base));
  expect(queryIdentity(grouped)).not.toBe(queryIdentity(base));
  expect(queryIdentity(flat)).not.toBe(queryIdentity(grouped));
});
```

- [ ] **Step 2: Failing test — store**

In `ui/src/store/workspace.test.ts`, inside `describe("useWorkspaceStore openTab wiring")`:

```ts
  it("appends a new tab for target.mode 'new' even in replace mode", () => {
    const store = useWorkspaceStore.getState();
    store.setNavigationMode("replace");
    store.openTab("page", "a.md", "A");
    store.openTab("page", "b.md", "B", { mode: "new" });
    const tabs = useWorkspaceStore.getState().tabs;
    expect(tabs.map((tab) => tab.path)).toEqual(["a.md", "b.md"]);
    expect(useWorkspaceStore.getState().activeTabId).toBe(tabs[1]?.id);
  });
```

Mirror the surrounding tests' reset pattern (`beforeEach` resets the store) and use the store's actual mode setter name (`setNavigationMode` per `workspace.ts:238`).

- [ ] **Step 3: Failing test — `useBaseView` query params**

Find the existing test that asserts `useBaseView`'s request (`grep -rn "views/{view}" ui/src --include=*.test.*`). If one exercises the query params, extend it; otherwise add to `ui/src/components/bases/__tests__/useBaseTableController.test.tsx` in Task 4 instead (the controller test already spies on `useBaseView(slug, view, overrides)`), and skip this step.

- [ ] **Step 4: Run the new tests to verify failure**

Run: `cd ui && bun run test src/components/bases/__tests__/embed-query.test.ts src/store/workspace.test.ts`
Expected: FAIL (`group_by` absent; second tab replaces the first).

- [ ] **Step 5: Implement**

`ui/src/api/bases.ts`:

```ts
export interface ViewOverrides {
  sort?: string;
  dir?: "asc" | "desc";
  filter?: BaseFilter;
  groupBy?: GroupOverride;
}
```

and in `useBaseView`'s `query`:

```ts
        query: {
          sort: overrides.sort,
          dir: overrides.dir,
          filter:
            overrides.filter === undefined
              ? undefined
              : JSON.stringify(overrides.filter),
          group_by: groupOverrideParam(overrides.groupBy),
        },
```

Import `type GroupOverride, groupOverrideParam` from `#/components/bases/view-overrides` (this file already imports from `#/components/bases/embed-query`, so the dependency direction is established).

`embed-query.ts`:

- `BaseEmbedConfig` gains `groupBy?: GroupOverride;`
- `NormalizedEmbedConfig` gains `groupBy: string | undefined;` (the wire sentinel)
- `normalizeEmbedConfiguration` sets `groupBy: groupOverrideParam(config.groupBy)`
- `queryIdentity` adds `groupBy: normalized.groupBy ?? null`
- `baseViewEvaluationBody` adds `...(normalized.groupBy === undefined ? {} : { group_by: normalized.groupBy })`

`workspace.ts`:

```ts
export interface OpenTabTarget {
  blockId?: string;
  /** `"new"` appends a tab regardless of the navigation mode. */
  mode?: "new";
}
```

and change the branch condition to `if (state.navigationMode === "replace" && state.activeTabId && target?.mode !== "new")`. `useOpenTabWithFolioHistory` forwards `target` untouched (`useFolioHistoryNavigation.ts:303`) — verify and leave it.

- [ ] **Step 6: Run tests, typecheck, lint; format touched files; commit**

Run: `cd ui && bun run test src/components/bases src/store && bun run typecheck && bun run lint`

```bash
git add ui/src/api/bases.ts ui/src/components/bases/embed-query.ts ui/src/store/workspace.ts ui/src/components/bases/__tests__/embed-query.test.ts ui/src/store/workspace.test.ts
git commit -m "feat(bases): send filter and group overrides; open-in-new-tab target"
```

---

### Task 4: Controller — `useViewOverrides`, save to view, model wiring

**Files:**
- Create: `ui/src/components/bases/useViewOverrides.ts`
- Modify: `ui/src/components/bases/useBaseTableController.ts`
- Test: `ui/src/components/bases/__tests__/useViewOverrides.test.tsx` (new), `ui/src/components/bases/__tests__/useBaseTableController.test.tsx` (extend), `ui/src/components/bases/__tests__/BaseTable.test.tsx` (mock update only)

**Interfaces:**
- Consumes: Task 2/3 exports; `useUpdateBase` from `#/api/bases`; `isApiConflict`, `formatApiError` from `#/api/error`.
- Produces on `BaseTableControllerModel`:

```ts
  overrides: ViewOverridesState;
  onAddQuickFilter(filter: QuickFilter): void;
  onRemoveQuickFilter(identity: string): void;
  onSetGroup(group: GroupOverride | undefined): void;
  onHideColumn(column: string): void;
  onShowHiddenColumns(): void;
  onClearOverrides(): void;
  onSaveOverrides(): void;
  onReloadDefinition(): void;
  overridesSave: OverridesSaveState;
```

with `export type OverridesSaveState = { phase: "idle" } | { phase: "saving" } | { phase: "conflict"; message: string } | { phase: "error"; message: string };` exported from `useViewOverrides.ts`.

- [ ] **Step 1: Failing hook test**

`ui/src/components/bases/__tests__/useViewOverrides.test.tsx`:

```tsx
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useViewOverrides } from "#/components/bases/useViewOverrides";

describe("useViewOverrides", () => {
  it("accumulates overrides and resets when the key changes", () => {
    const { result, rerender } = renderHook(({ key }) => useViewOverrides(key), {
      initialProps: { key: "reading:continues" },
    });
    act(() => {
      result.current.addQuickFilter({ field: "status", op: "eq", value: "reading", label: "status is reading" });
      result.current.setGroup({ kind: "by", field: "status" });
      result.current.hideColumn("rating");
    });
    expect(result.current.state.quickFilters).toHaveLength(1);
    expect(result.current.state.group).toEqual({ kind: "by", field: "status" });
    expect(result.current.state.hiddenColumns).toEqual(["rating"]);

    rerender({ key: "reading:shelf" });
    expect(result.current.state.quickFilters).toEqual([]);
    expect(result.current.state.group).toBeUndefined();
    expect(result.current.state.hiddenColumns).toEqual([]);
  });

  it("clears everything on demand", () => {
    const { result } = renderHook(() => useViewOverrides("k"));
    act(() => {
      result.current.hideColumn("author");
      result.current.setGroup({ kind: "flat" });
      result.current.clear();
    });
    expect(result.current.state.hiddenColumns).toEqual([]);
    expect(result.current.state.group).toBeUndefined();
  });
});
```

- [ ] **Step 2: Implement `useViewOverrides.ts`**

```ts
import { useCallback, useState } from "react";
import {
  EMPTY_OVERRIDES,
  type GroupOverride,
  type QuickFilter,
  type ViewOverridesState,
  withGroup,
  withHiddenColumn,
  withoutHiddenColumns,
  withoutQuickFilter,
  withQuickFilter,
} from "./view-overrides";

export type OverridesSaveState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "conflict"; message: string }
  | { phase: "error"; message: string };

export interface ViewOverridesModel {
  state: ViewOverridesState;
  addQuickFilter(filter: QuickFilter): void;
  removeQuickFilter(identity: string): void;
  setGroup(group: GroupOverride | undefined): void;
  hideColumn(column: string): void;
  showHiddenColumns(): void;
  clear(): void;
}

/** Request-time overrides for one (base, view) pair; `resetKey` changes wipe them. */
export function useViewOverrides(resetKey: string): ViewOverridesModel {
  const [stored, setStored] = useState<{ key: string; state: ViewOverridesState }>({
    key: resetKey,
    state: EMPTY_OVERRIDES,
  });
  const state = stored.key === resetKey ? stored.state : EMPTY_OVERRIDES;
  const update = useCallback(
    (transition: (current: ViewOverridesState) => ViewOverridesState) =>
      setStored((current) => ({
        key: resetKey,
        state: transition(current.key === resetKey ? current.state : EMPTY_OVERRIDES),
      })),
    [resetKey],
  );
  return {
    state,
    addQuickFilter: useCallback((filter) => update((s) => withQuickFilter(s, filter)), [update]),
    removeQuickFilter: useCallback((identity) => update((s) => withoutQuickFilter(s, identity)), [update]),
    setGroup: useCallback((group) => update((s) => withGroup(s, group)), [update]),
    hideColumn: useCallback((column) => update((s) => withHiddenColumn(s, column)), [update]),
    showHiddenColumns: useCallback(() => update(withoutHiddenColumns), [update]),
    clear: useCallback(() => update(() => EMPTY_OVERRIDES), [update]),
  };
}
```

Run: `cd ui && bun run test src/components/bases/__tests__/useViewOverrides.test.tsx` → PASS.

- [ ] **Step 3: Failing controller tests**

In `useBaseTableController.test.tsx`: extend the `#/api/bases` mock with `useUpdateBase: () => ({ mutateAsync: mocks.updateBase, isPending: false })` and add `updateBase: vi.fn()` to `mocks`. Then add a `describe("view overrides")`:

```tsx
describe("view overrides", () => {
  it("sends quick filters and the group override with the standalone view request", async () => {
    const user = userEvent.setup();
    let model!: ReturnType<typeof useBaseTableController>;
    function Probe({ value }: { value: BaseTableControllerOptions }) {
      model = useBaseTableController(value);
      return null;
    }
    render(<Probe value={options({ mode: "standalone", filter: undefined })} />);
    act(() => {
      model.onAddQuickFilter({ field: "status", op: "eq", value: "reading", label: "status is reading" });
      model.onSetGroup({ kind: "flat" });
    });
    await waitFor(() =>
      expect(mocks.useBaseView).toHaveBeenLastCalledWith("reading", "Continues", {
        filter: { field: "status", op: "eq", value: "reading" },
        groupBy: { kind: "flat" },
      }),
    );
    expect(model.overrides.quickFilters).toHaveLength(1);
    void user;
  });

  it("composes the fence filter with quick filters for an embedded view", async () => {
    let model!: ReturnType<typeof useBaseTableController>;
    function Probe({ value }: { value: BaseTableControllerOptions }) {
      model = useBaseTableController(value);
      return null;
    }
    render(<Probe value={options()} />); // embedded, fence filter = readingFilter
    act(() => {
      model.onAddQuickFilter({ field: "status", op: "ne", value: "finished", label: "status is not finished" });
      model.onSetGroup({ kind: "by", field: "status" });
    });
    await waitFor(() =>
      expect(mocks.currentEvaluationConfig).toMatchObject({
        filter: { all: [readingFilter, { field: "status", op: "ne", value: "finished" }] },
        groupBy: { kind: "by", field: "status" },
      }),
    );
  });

  it("resets overrides when the view changes", () => {
    let model!: ReturnType<typeof useBaseTableController>;
    const onViewChange = vi.fn();
    function Probe({ value }: { value: BaseTableControllerOptions }) {
      model = useBaseTableController(value);
      return null;
    }
    const { rerender } = render(<Probe value={options({ mode: "standalone", onViewChange })} />);
    act(() => model.onHideColumn("status"));
    expect(model.overrides.hiddenColumns).toEqual(["status"]);
    act(() => model.onViewChange("Shelf"));
    rerender(<Probe value={options({ mode: "standalone", onViewChange, activeView: "Shelf" })} />);
    expect(model.overrides.hiddenColumns).toEqual([]);
  });

  it("saves overrides into the view through the revision-guarded PUT and clears them", async () => {
    mocks.updateBase.mockResolvedValue({ revision: "r2", diagnostics: [] });
    let model!: ReturnType<typeof useBaseTableController>;
    const onSortChange = vi.fn();
    function Probe({ value }: { value: BaseTableControllerOptions }) {
      model = useBaseTableController(value);
      return null;
    }
    render(
      <Probe
        value={options({
          mode: "standalone",
          filter: undefined,
          sort: [{ field: "status", dir: "desc" }],
          onSortChange,
        })}
      />,
    );
    act(() => {
      model.onAddQuickFilter({ field: "status", op: "eq", value: "reading", label: "status is reading" });
      model.onHideColumn("status");
    });
    await act(async () => model.onSaveOverrides());
    expect(mocks.updateBase).toHaveBeenCalledWith({
      params: { path: { slug: "reading" } },
      body: {
        expected_revision: definition.revision,
        definition: {
          name: "Reading Log",
          properties: definition.properties,
          views: [
            {
              name: "Continues",
              layout: "table",
              columns: ["title"],
              filter: { field: "status", op: "eq", value: "reading" },
              sort: [{ field: "status", dir: "desc" }],
            },
            { name: "Shelf", layout: "table", columns: ["title"] },
          ],
        },
        view_origins: [
          { kind: "existing", name: "Continues" },
          { kind: "existing", name: "Shelf" },
        ],
      },
    });
    expect(model.overrides.quickFilters).toEqual([]);
    expect(onSortChange).toHaveBeenCalledWith(undefined);
    expect(model.overridesSave).toEqual({ phase: "idle" });
  });

  it("reports a conflict and keeps the overrides", async () => {
    mocks.updateBase.mockRejectedValue({ status: 409, error: "conflict", detail: {} });
    let model!: ReturnType<typeof useBaseTableController>;
    function Probe({ value }: { value: BaseTableControllerOptions }) {
      model = useBaseTableController(value);
      return null;
    }
    render(<Probe value={options({ mode: "standalone", filter: undefined })} />);
    act(() => model.onSetGroup({ kind: "by", field: "status" }));
    await act(async () => model.onSaveOverrides());
    expect(model.overridesSave).toEqual({
      phase: "conflict",
      message: "This base changed elsewhere. Reload, then save again.",
    });
    expect(model.overrides.group).toEqual({ kind: "by", field: "status" });
    await act(async () => model.onReloadDefinition());
    expect(mocks.detailRefetch).toHaveBeenCalled();
    expect(model.overridesSave).toEqual({ phase: "idle" });
  });
});
```

Check how `isApiConflict` recognises an error (`ui/src/api/error.ts:7-37`: `isApiError` shape) and build the rejected value to match it exactly. The definition fixture in this file has `views[0].columns = ["title", "status"]`, so hiding `status` yields `columns: ["title"]` as asserted.

- [ ] **Step 4: Run to verify failure**

Run: `cd ui && bun run test src/components/bases/__tests__/useBaseTableController.test.tsx -t "view overrides"`
Expected: FAIL (`onAddQuickFilter` is not a function).

- [ ] **Step 5: Wire the controller**

In `useBaseTableController.ts`:

1. Imports: `useUpdateBase` from `#/api/bases`; `formatApiError`, `isApiConflict` from `#/api/error`; `applyOverridesToView`, `composeQuickFilters`, `definitionPayload`, `type GroupOverride`, `type QuickFilter`, `type ViewOverridesState` from `./view-overrides`; `type OverridesSaveState`, `useViewOverrides` from `./useViewOverrides`.
2. Add the model fields listed in **Interfaces** to `BaseTableControllerModel`.
3. After `activeView` is computed: `const overrides = useViewOverrides(`${mode}:${slug}:${asciiCaseFold(activeView)}`);` and `const effectiveFilter = useMemo(() => composeQuickFilters(mode === "embedded" ? filter : undefined, overrides.state.quickFilters), [filter, mode, overrides.state.quickFilters]);`
4. Standalone request: `useBaseView(slug, activeView, { ...sortOverride, ...(effectiveFilter === undefined ? {} : { filter: effectiveFilter }), ...(overrides.state.group === undefined ? {} : { groupBy: overrides.state.group }) })` — keep the object shape `{}` when nothing is set so the existing test (`useBaseView` called with `{}`) still passes.
5. Embedded config: `filter: mode === "embedded" ? effectiveFilter : undefined`, plus `...(overrides.state.group === undefined ? {} : { groupBy: overrides.state.group })`; add `effectiveFilter`, `overrides.state.group` to the deps.
6. `memberCreationSource` (embedded): `embedFilter: effectiveFilter`.
7. Save state + handlers:

```ts
  const updateBase = useUpdateBase();
  const [overridesSave, setOverridesSave] = useState<OverridesSaveState>({ phase: "idle" });
  const baseColumns = useMemo(
    () =>
      activeViewDefinition?.columns && activeViewDefinition.columns.length > 0
        ? activeViewDefinition.columns
        : ["title"],
    [activeViewDefinition?.columns],
  );
  const saveOverrides = useCallback(async () => {
    const current = detail.data;
    const view = activeViewDefinition;
    if (!current || !view) return;
    setOverridesSave({ phase: "saving" });
    const nextView = applyOverridesToView(view, overrides.state, sort, baseColumns);
    try {
      await updateBase.mutateAsync({
        params: { path: { slug } },
        body: {
          expected_revision: current.revision,
          definition: definitionPayload(current, nextView),
          view_origins: (current.views ?? []).map((candidate) => ({
            kind: "existing" as const,
            name: candidate.name,
          })),
        },
      });
      overrides.clear();
      notifySortChange(undefined);
      setOverridesSave({ phase: "idle" });
    } catch (error) {
      setOverridesSave(
        isApiConflict(error)
          ? { phase: "conflict", message: "This base changed elsewhere. Reload, then save again." }
          : { phase: "error", message: formatApiError(error, "The view could not be saved.") },
      );
    }
  }, [activeViewDefinition, baseColumns, detail.data, notifySortChange, overrides, slug, sort, updateBase]);
  const reloadDefinition = useCallback(async () => {
    await detailRefetch();
    setOverridesSave({ phase: "idle" });
  }, [detailRefetch]);
  const clearOverrides = useCallback(() => {
    overrides.clear();
    notifySortChange(undefined);
    setOverridesSave({ phase: "idle" });
  }, [notifySortChange, overrides]);
```

`overrides` (the model object) is a new object every render; depend on its stable callbacks instead (`overrides.clear`, etc.) to keep the `useCallback` deps honest — restructure as needed so biome's `useExhaustiveDependencies` stays clean.

8. In `handleViewChange`, also `setOverridesSave({ phase: "idle" })` (the key change already resets the state).
9. Return the new fields: `overrides: overrides.state`, `onAddQuickFilter: overrides.addQuickFilter`, `onRemoveQuickFilter: overrides.removeQuickFilter`, `onSetGroup: overrides.setGroup`, `onHideColumn: overrides.hideColumn`, `onShowHiddenColumns: overrides.showHiddenColumns`, `onClearOverrides: clearOverrides`, `onSaveOverrides: () => void saveOverrides()`, `onReloadDefinition: () => void reloadDefinition()`, `overridesSave`.

- [ ] **Step 6: Update sibling test mocks**

`BaseTable.test.tsx` and `BaseEmbedElement.test.tsx` mock `#/api/bases` / the controller. Add `useUpdateBase: () => ({ mutateAsync: vi.fn(), isPending: false })` to any `#/api/bases` mock that spreads `actual` and renders the real controller (`BaseTable.test.tsx`). `BaseEmbedElement.test.tsx` installs a whole `model` — extend its installed model with the new fields as no-op functions (`overrides: EMPTY_OVERRIDES`, `overridesSave: { phase: "idle" }`, handlers `vi.fn()`), otherwise `BaseTableView` gets `undefined` props, which Task 5 makes optional — so this may only be needed if TypeScript complains.

- [ ] **Step 7: Run the bases suites, typecheck, lint; format; commit**

Run: `cd ui && bun run test src/components/bases src/editor/elements && bun run typecheck && bun run lint`

```bash
git add ui/src/components/bases/useViewOverrides.ts ui/src/components/bases/useBaseTableController.ts ui/src/components/bases/__tests__/useViewOverrides.test.tsx ui/src/components/bases/__tests__/useBaseTableController.test.tsx ui/src/components/bases/__tests__/BaseTable.test.tsx
git commit -m "feat(bases): controller-owned view overrides with save-to-view"
```

---

### Task 5: Components — header menu, cell/row menus, overrides strip, table wiring

**Files:**
- Create: `ui/src/components/bases/BaseHeaderMenu.tsx`
- Create: `ui/src/components/bases/BaseRowMenu.tsx`
- Create: `ui/src/components/bases/ViewOverridesStrip.tsx`
- Create: `ui/src/components/bases/ArchiveRowDialog.tsx`
- Modify: `ui/src/components/bases/BaseTableView.tsx`
- Test: `ui/src/components/bases/__tests__/BaseTableMenus.test.tsx` (new)

**Interfaces:**
- Consumes: Task 2 pure functions; Task 4 model fields; `#/components/ui/menu` (`ContextMenuTrigger`, `MenuTrigger`, `Menu`, `MenuItem`, `MenuSeparator`, `SubmenuTrigger`), `#/components/ui/button`, `#/components/ui/dialog`.
- Produces on `BaseTableViewProps` (all optional so existing callers compile):

```ts
  overrides?: ViewOverridesState;
  onAddQuickFilter?(filter: QuickFilter): void;
  onRemoveQuickFilter?(identity: string): void;
  onSetGroup?(group: GroupOverride | undefined): void;
  onHideColumn?(column: string): void;
  onShowHiddenColumns?(): void;
  onClearOverrides?(): void;
  onSaveOverrides?(): void;
  onReloadDefinition?(): void;
  overridesSave?: OverridesSaveState;
  onOpenPageInNewTab?(path: string): void;
  onCopyWikilink?(row: QueryRow): void;
  onCopyValue?(value: CellValue): void;
  onDuplicateRow?(row: QueryRow): void;
  /** Resolves once the page is archived; rejects with an Error whose message the dialog shows. */
  onArchiveRow?(row: QueryRow): Promise<void>;
  rowActionError?: string;
```

and `BaseTableViewHandle.focusRow(rowId: string): boolean`.

- [ ] **Step 1: Failing component tests**

`ui/src/components/bases/__tests__/BaseTableMenus.test.tsx` — copy the `definition`, `row`, `flat`, `enabledCapability`, `memberDraftFields`, `renderView` scaffolding from `BaseTableView.test.tsx` (lines 30-136) into this file (self-contained; do not import from the other test), add `{ key: "due", definition: { type: "date" } }` to `properties`, `due: "2026-08-28"` to `row.columns`, and use view `Continues` with `columns: ["title", "author", "status", "due"]`. Then:

```tsx
const overrideSpies = () => ({
  onAddQuickFilter: vi.fn(),
  onRemoveQuickFilter: vi.fn(),
  onSetGroup: vi.fn(),
  onHideColumn: vi.fn(),
  onShowHiddenColumns: vi.fn(),
  onClearOverrides: vi.fn(),
  onSaveOverrides: vi.fn(),
  onReloadDefinition: vi.fn(),
  onOpenPageInNewTab: vi.fn(),
  onCopyWikilink: vi.fn(),
  onCopyValue: vi.fn(),
  onDuplicateRow: vi.fn(),
  onArchiveRow: vi.fn().mockResolvedValue(undefined),
});

describe("column header menu", () => {
  it("opens from the ⋯ button and dispatches sort, group and hide", async () => {
    const user = userEvent.setup();
    const spies = overrideSpies();
    const view = renderView({ ...spies, overrides: EMPTY_OVERRIDES });
    await user.click(screen.getByRole("button", { name: "author column menu" }));
    const menu = await screen.findByRole("menu", { name: "author column menu" });
    expect(within(menu).getByRole("menuitem", { name: "Sort ascending" })).toBeVisible();
    await user.click(within(menu).getByRole("menuitem", { name: "Sort descending" }));
    expect(view.onSortChange).toHaveBeenCalledWith([{ field: "author", dir: "desc" }]);

    await user.click(screen.getByRole("button", { name: "author column menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Group by author" }));
    expect(spies.onSetGroup).toHaveBeenCalledWith({ kind: "by", field: "author" });

    await user.click(screen.getByRole("button", { name: "author column menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Hide column" }));
    expect(spies.onHideColumn).toHaveBeenCalledWith("author");
  });

  it("offers filter presets in a submenu", async () => {
    const user = userEvent.setup();
    const spies = overrideSpies();
    renderView({ ...spies, overrides: EMPTY_OVERRIDES });
    await user.click(screen.getByRole("button", { name: "due column menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Filter" }));
    await user.click(await screen.findByRole("menuitem", { name: "due is this week" }));
    expect(spies.onAddQuickFilter).toHaveBeenCalledWith({ field: "due", op: "is_this_week", label: "due is this week" });
  });

  it("never hides the title column and shows Ungroup for the grouped column", async () => {
    const user = userEvent.setup();
    const spies = overrideSpies();
    renderView({ ...spies, overrides: { ...EMPTY_OVERRIDES, group: { kind: "by", field: "status" } } });
    await user.click(screen.getByRole("button", { name: "title column menu" }));
    const hide = await screen.findByRole("menuitem", { name: /Hide column/ });
    expect(hide).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "status column menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Ungroup" }));
    expect(spies.onSetGroup).toHaveBeenCalledWith({ kind: "flat" });
  });

  it("opens from a right-click on the header", async () => {
    const user = userEvent.setup();
    renderView({ ...overrideSpies(), overrides: EMPTY_OVERRIDES });
    await user.pointer({ target: screen.getByText("author"), keys: "[MouseRight]" });
    expect(await screen.findByRole("menuitem", { name: "Sort ascending" })).toBeVisible();
  });

  it("is absent when read-only", () => {
    renderView({ ...overrideSpies(), overrides: EMPTY_OVERRIDES, readOnly: true });
    expect(screen.queryByRole("button", { name: "author column menu" })).not.toBeInTheDocument();
  });
});

describe("cell and row menu", () => {
  it("right-click on a cell offers the value filter, copy, and row actions", async () => {
    const user = userEvent.setup();
    const spies = overrideSpies();
    const view = renderView({ ...spies, overrides: EMPTY_OVERRIDES });
    await user.pointer({ target: screen.getByRole("button", { name: /Edit status/ }), keys: "[MouseRight]" });
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "status is reading" }));
    expect(spies.onAddQuickFilter).toHaveBeenCalledWith({ field: "status", op: "eq", value: "reading", label: "status is reading" });

    await user.pointer({ target: screen.getByRole("button", { name: /Edit status/ }), keys: "[MouseRight]" });
    await user.click(await screen.findByRole("menuitem", { name: "Copy value" }));
    expect(spies.onCopyValue).toHaveBeenCalledWith("reading");

    await user.pointer({ target: screen.getByRole("button", { name: /Edit status/ }), keys: "[MouseRight]" });
    await user.click(await screen.findByRole("menuitem", { name: "Open in new tab" }));
    expect(spies.onOpenPageInNewTab).toHaveBeenCalledWith("book.md");
    void view;
  });

  it("offers the date submenu on date cells", async () => {
    const user = userEvent.setup();
    const spies = overrideSpies();
    renderView({ ...spies, overrides: EMPTY_OVERRIDES });
    await user.pointer({ target: screen.getByRole("button", { name: /Edit due/ }), keys: "[MouseRight]" });
    await user.click(await screen.findByRole("menuitem", { name: "Filter by date" }));
    await user.click(await screen.findByRole("menuitem", { name: "Today" }));
    expect(spies.onAddQuickFilter).toHaveBeenCalledWith({ field: "due", op: "is_today", label: "due is today" });
  });

  it("the ⋯ button lists row actions and archive confirms through a dialog", async () => {
    const user = userEvent.setup();
    const spies = overrideSpies();
    renderView({ ...spies, overrides: EMPTY_OVERRIDES });
    await user.click(screen.getByRole("button", { name: "Row actions for The Book of the New Sun" }));
    await user.click(await screen.findByRole("menuitem", { name: "Copy wikilink" }));
    expect(spies.onCopyWikilink).toHaveBeenCalledWith(expect.objectContaining({ path: "book.md" }));

    await user.click(screen.getByRole("button", { name: "Row actions for The Book of the New Sun" }));
    await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    expect(spies.onDuplicateRow).toHaveBeenCalledWith(expect.objectContaining({ id: "01" }));

    await user.click(screen.getByRole("button", { name: "Row actions for The Book of the New Sun" }));
    await user.click(await screen.findByRole("menuitem", { name: "Archive…" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive page" });
    expect(within(dialog).getByText("You can restore this page from the Rubbish Bin.")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Confirm archive" }));
    await waitFor(() => expect(spies.onArchiveRow).toHaveBeenCalledWith(expect.objectContaining({ id: "01" })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps only navigation items when read-only", async () => {
    const user = userEvent.setup();
    renderView({ ...overrideSpies(), overrides: EMPTY_OVERRIDES, readOnly: true });
    await user.pointer({ target: screen.getByText("The Book of the New Sun"), keys: "[MouseRight]" });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Open" })).toBeVisible();
    expect(within(menu).queryByRole("menuitem", { name: "Duplicate" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Archive…" })).not.toBeInTheDocument();
  });

  it("opens the cell menu from the keyboard", async () => {
    const platformSpy = vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    try {
      const user = userEvent.setup();
      renderView({ ...overrideSpies(), overrides: EMPTY_OVERRIDES });
      await user.click(screen.getByRole("button", { name: /Edit author/ }));
      await user.keyboard("{Escape}");
      screen.getByRole("button", { name: /Edit author/ }).focus();
      await user.keyboard("{Control>}{Enter}{/Control}");
      expect(await screen.findByRole("menuitem", { name: "Open" })).toBeVisible();
    } finally {
      platformSpy.mockRestore();
    }
  });
});

describe("overrides strip", () => {
  it("renders chips, removes on click, clears and saves", async () => {
    const user = userEvent.setup();
    const spies = overrideSpies();
    const view = renderView({
      ...spies,
      sort: [{ field: "author", dir: "asc" }],
      overrides: {
        quickFilters: [{ field: "status", op: "eq", value: "reading", label: "status is reading" }],
        group: { kind: "by", field: "status" },
        hiddenColumns: ["author"],
      },
      overridesSave: { phase: "idle" },
    });
    const strip = screen.getByRole("group", { name: "View overrides" });
    await user.click(within(strip).getByRole("button", { name: "Remove Sorted by author ↑" }));
    expect(view.onSortChange).toHaveBeenCalledWith(undefined);
    await user.click(within(strip).getByRole("button", { name: "Remove status is reading" }));
    expect(spies.onRemoveQuickFilter).toHaveBeenCalledWith(quickFilterIdentity({ field: "status", op: "eq", value: "reading", label: "" }));
    await user.click(within(strip).getByRole("button", { name: "Remove Grouped by status" }));
    expect(spies.onSetGroup).toHaveBeenCalledWith(undefined);
    await user.click(within(strip).getByRole("button", { name: "Remove Hidden: author" }));
    expect(spies.onShowHiddenColumns).toHaveBeenCalled();
    await user.click(within(strip).getByRole("button", { name: "Clear" }));
    expect(spies.onClearOverrides).toHaveBeenCalled();
    await user.click(within(strip).getByRole("button", { name: "Save to view" }));
    expect(spies.onSaveOverrides).toHaveBeenCalled();
  });

  it("hides the strip without overrides and shows the conflict with a reload", async () => {
    const user = userEvent.setup();
    const spies = overrideSpies();
    const view = renderView({ ...spies, overrides: EMPTY_OVERRIDES });
    expect(screen.queryByRole("group", { name: "View overrides" })).not.toBeInTheDocument();
    view.rerender({
      overrides: { ...EMPTY_OVERRIDES, group: { kind: "flat" } },
      overridesSave: { phase: "conflict", message: "This base changed elsewhere. Reload, then save again." },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("This base changed elsewhere");
    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(spies.onReloadDefinition).toHaveBeenCalled();
    expect(screen.getByText("Ungrouped")).toBeVisible();
  });

  it("hides columns from the grid and groups by the override", () => {
    renderView({
      ...overrideSpies(),
      overrides: { ...EMPTY_OVERRIDES, hiddenColumns: ["author"] },
    });
    expect(screen.queryByRole("columnheader", { name: /author/ })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /status/ })).toBeVisible();
  });
});
```

Import `EMPTY_OVERRIDES`, `quickFilterIdentity` from `#/components/bases/view-overrides`; `within`, `waitFor` from Testing Library. `renderView` passes `readOnly` through `overrides` spread — make sure the helper forwards arbitrary props (it does via `{...overrides}`).

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && bun run test src/components/bases/__tests__/BaseTableMenus.test.tsx`
Expected: FAIL (no menu buttons).

- [ ] **Step 3: Implement `BaseHeaderMenu.tsx`**

```tsx
import type { ReactNode } from "react";
import { Button } from "#/components/ui/button";
import {
  ContextMenuTrigger,
  Menu,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  SubmenuTrigger,
} from "#/components/ui/menu";
import type { SortKey } from "#/api/bases";
import type { GroupOverride, QuickFilter } from "./view-overrides";

export interface BaseHeaderMenuProps {
  column: string;
  label: string;
  allowsSorting: boolean;
  groupable: boolean;
  /** True when the effective grouping already uses this column. */
  groupedByThis: boolean;
  hideable: boolean;
  presets: QuickFilter[];
  onSortChange(sort: SortKey[] | undefined): void;
  onAddQuickFilter(filter: QuickFilter): void;
  onSetGroup(group: GroupOverride | undefined): void;
  onHideColumn(column: string): void;
  children: ReactNode;
}

function HeaderMenu({
  column,
  label,
  allowsSorting,
  groupable,
  groupedByThis,
  hideable,
  presets,
  onSortChange,
  onAddQuickFilter,
  onSetGroup,
  onHideColumn,
}: Omit<BaseHeaderMenuProps, "children">) {
  const byIdentity = new Map(presets.map((preset, index) => [`filter:${index}`, preset]));
  return (
    <Menu
      aria-label={`${label} column menu`}
      onAction={(key) => {
        const id = String(key);
        if (id === "sort-asc") onSortChange([{ field: column, dir: "asc" }]);
        else if (id === "sort-desc") onSortChange([{ field: column, dir: "desc" }]);
        else if (id === "group") onSetGroup(groupedByThis ? { kind: "flat" } : { kind: "by", field: column });
        else if (id === "hide") onHideColumn(column);
        else {
          const preset = byIdentity.get(id);
          if (preset) onAddQuickFilter(preset);
        }
      }}
    >
      <MenuItem id="sort-asc" isDisabled={!allowsSorting} description={allowsSorting ? undefined : "Not sortable"}>
        Sort ascending
      </MenuItem>
      <MenuItem id="sort-desc" isDisabled={!allowsSorting} description={allowsSorting ? undefined : "Not sortable"}>
        Sort descending
      </MenuItem>
      {presets.length > 0 ? (
        <SubmenuTrigger>
          <MenuItem id="filter">Filter</MenuItem>
          <Menu aria-label={`Filter ${label}`} onAction={(key) => { const p = byIdentity.get(String(key)); if (p) onAddQuickFilter(p); }}>
            {presets.map((preset, index) => (
              <MenuItem key={`filter:${index}`} id={`filter:${index}`}>{preset.label}</MenuItem>
            ))}
          </Menu>
        </SubmenuTrigger>
      ) : null}
      <MenuSeparator />
      <MenuItem id="group" isDisabled={!groupable} description={groupable ? undefined : "Cannot group by this column"}>
        {groupedByThis ? "Ungroup" : `Group by ${label}`}
      </MenuItem>
      <MenuItem id="hide" isDisabled={!hideable} description={hideable ? undefined : column === "title" ? "The title column stays visible" : "The last column stays visible"}>
        Hide column
      </MenuItem>
    </Menu>
  );
}

/** Column header content with a `⋯` menu button and a right-click menu. */
export function BaseHeaderMenu(props: BaseHeaderMenuProps) {
  const { children, label } = props;
  return (
    <ContextMenuTrigger>
      <div className="flex items-center gap-1" data-column={props.column}>
        {children}
        <MenuTrigger>
          <Button variant="ghost" size="sm" aria-label={`${label} column menu`} className="px-1 py-0 opacity-60 hover:opacity-100">
            ⋯
          </Button>
          <HeaderMenu {...props} />
        </MenuTrigger>
      </div>
      <HeaderMenu {...props} />
    </ContextMenuTrigger>
  );
}
```

RAC submenu items dispatch `onAction` on their own `Menu`; the root `onAction` receives only root keys. Keep both handlers (the root's fallback is harmless).

- [ ] **Step 4: Implement `BaseRowMenu.tsx`**

```tsx
import type { ReactNode } from "react";
import type { PropertyDefinition, QueryRow } from "#/api/bases";
import { Button } from "#/components/ui/button";
import { ContextMenuTrigger, Menu, MenuItem, MenuSeparator, MenuTrigger, SubmenuTrigger } from "#/components/ui/menu";
import type { CellValue } from "./cells/types";
import { DATE_PRESETS, datePresetFilter, isDateLike, quickFiltersForCell, type QuickFilterType } from "./quick-filters";
import type { QuickFilter } from "./view-overrides";

export interface RowMenuActions {
  onOpenPage(path: string): void;
  onOpenPageInNewTab?(path: string): void;
  onCopyWikilink?(row: QueryRow): void;
  onDuplicateRow?(row: QueryRow): void;
  onArchiveRow?(row: QueryRow): void;
}

export function rowMenuLabel(row: QueryRow): string {
  return row.title ?? row.path;
}

function RowItems({ readOnly }: { readOnly: boolean }) {
  return (
    <>
      <MenuItem id="open">Open</MenuItem>
      <MenuItem id="open-new-tab">Open in new tab</MenuItem>
      <MenuItem id="copy-wikilink">Copy wikilink</MenuItem>
      {readOnly ? null : (
        <>
          <MenuSeparator />
          <MenuItem id="duplicate">Duplicate</MenuItem>
          <MenuItem id="archive" variant="destructive">Archive…</MenuItem>
        </>
      )}
    </>
  );
}

function dispatchRowAction(key: string, row: QueryRow, actions: RowMenuActions): boolean {
  switch (key) {
    case "open": actions.onOpenPage(row.path); return true;
    case "open-new-tab": actions.onOpenPageInNewTab?.(row.path); return true;
    case "copy-wikilink": actions.onCopyWikilink?.(row); return true;
    case "duplicate": actions.onDuplicateRow?.(row); return true;
    case "archive": actions.onArchiveRow?.(row); return true;
    default: return false;
  }
}

export interface RowActionsButtonProps { row: QueryRow; readOnly: boolean; actions: RowMenuActions; }

/** The ghost `⋯` button in a row's first cell. */
export function RowActionsButton({ row, readOnly, actions }: RowActionsButtonProps) {
  const label = `Row actions for ${rowMenuLabel(row)}`;
  return (
    <MenuTrigger>
      <Button
        variant="ghost"
        size="sm"
        aria-label={label}
        className="ml-auto shrink-0 px-1 py-0 opacity-0 focus-visible:opacity-100 group-data-[hovered]:opacity-100"
      >
        ⋯
      </Button>
      <Menu aria-label={label} onAction={(key) => dispatchRowAction(String(key), row, actions)}>
        <RowItems readOnly={readOnly} />
      </Menu>
    </MenuTrigger>
  );
}

export interface CellContextMenuProps {
  row: QueryRow;
  column: string;
  label: string;
  type: QuickFilterType | undefined;
  definition: PropertyDefinition | undefined;
  value: CellValue | undefined;
  readOnly: boolean;
  actions: RowMenuActions;
  onAddQuickFilter?(filter: QuickFilter): void;
  onCopyValue?(value: CellValue): void;
  children: ReactNode;
}

/** Right-click / context-key menu for one cell: quick filters, copy, row items. */
export function CellContextMenu({ row, column, label, type, value, readOnly, actions, onAddQuickFilter, onCopyValue, children }: CellContextMenuProps) {
  const filterable = !readOnly && type !== undefined && onAddQuickFilter !== undefined;
  const quick = filterable ? quickFiltersForCell(column, type, value, label) : [];
  const dateLike = filterable && isDateLike(type);
  const menuLabel = `${rowMenuLabel(row)} — ${label}`;
  return (
    <ContextMenuTrigger>
      <div className="flex min-w-0 items-center" data-row-id={row.id} data-column={column}>
        {children}
      </div>
      <Menu
        aria-label={menuLabel}
        onAction={(key) => {
          const id = String(key);
          if (dispatchRowAction(id, row, actions)) return;
          if (id === "copy-value") { onCopyValue?.(value ?? null); return; }
          if (id.startsWith("quick:")) { const f = quick[Number(id.slice(6))]; if (f) onAddQuickFilter?.(f); }
        }}
      >
        {quick.map((filter, index) => (
          <MenuItem key={`quick:${index}`} id={`quick:${index}`}>{filter.label}</MenuItem>
        ))}
        {dateLike ? (
          <SubmenuTrigger>
            <MenuItem id="date">Filter by date</MenuItem>
            <Menu aria-label={`Filter ${label} by date`} onAction={(key) => onAddQuickFilter?.(datePresetFilter(column, label, String(key) as QuickFilter["op"]))}>
              {DATE_PRESETS.map((preset) => (
                <MenuItem key={preset.op} id={preset.op}>{preset.label}</MenuItem>
              ))}
            </Menu>
          </SubmenuTrigger>
        ) : null}
        {type !== undefined && onCopyValue ? <MenuItem id="copy-value">Copy value</MenuItem> : null}
        {(quick.length > 0 || dateLike || (type !== undefined && onCopyValue)) ? <MenuSeparator /> : null}
        <RowItems readOnly={readOnly} />
      </Menu>
    </ContextMenuTrigger>
  );
}
```

- [ ] **Step 5: Implement `ViewOverridesStrip.tsx`**

```tsx
import type { SortKey } from "#/api/bases";
import { Button } from "#/components/ui/button";
import type { OverridesSaveState } from "./useViewOverrides";
import { hasOverrides, quickFilterIdentity, type ViewOverridesState } from "./view-overrides";

export interface ViewOverridesStripProps {
  sort: SortKey[] | undefined;
  overrides: ViewOverridesState;
  labelFor(column: string): string;
  readOnly: boolean;
  save: OverridesSaveState;
  onSortChange(sort: SortKey[] | undefined): void;
  onRemoveQuickFilter(identity: string): void;
  onSetGroup(group: undefined): void;
  onShowHiddenColumns(): void;
  onClear(): void;
  onSave(): void;
  onReload(): void;
}

function Chip({ text, onRemove }: { text: string; onRemove(): void }) {
  return (
    <Button variant="ghost" size="sm" aria-label={`Remove ${text}`} onPress={onRemove}
      className="cl-mono gap-1 border border-rule px-2 py-0.5 text-[10px] uppercase tracking-[0.1em]">
      {text} <span aria-hidden="true">×</span>
    </Button>
  );
}

export function ViewOverridesStrip(props: ViewOverridesStripProps) {
  const { sort, overrides, labelFor, readOnly, save } = props;
  if (!hasOverrides(overrides, sort)) return null;
  const primarySort = sort?.[0];
  const hidden = overrides.hiddenColumns;
  const hiddenText = hidden.length <= 3 ? `Hidden: ${hidden.map(labelFor).join(", ")}` : `${hidden.length} hidden columns`;
  const message = save.phase === "conflict" || save.phase === "error" ? save.message : undefined;
  return (
    <div className="flex flex-col gap-1">
      <div role="group" aria-label="View overrides" className="flex flex-wrap items-center gap-1 border-b border-rule pb-1">
        {primarySort ? (
          <Chip text={`Sorted by ${labelFor(primarySort.field)} ${primarySort.dir === "desc" ? "↓" : "↑"}`} onRemove={() => props.onSortChange(undefined)} />
        ) : null}
        {overrides.quickFilters.map((filter) => (
          <Chip key={quickFilterIdentity(filter)} text={filter.label} onRemove={() => props.onRemoveQuickFilter(quickFilterIdentity(filter))} />
        ))}
        {overrides.group ? (
          <Chip text={overrides.group.kind === "flat" ? "Ungrouped" : `Grouped by ${labelFor(overrides.group.field)}`} onRemove={() => props.onSetGroup(undefined)} />
        ) : null}
        {hidden.length > 0 ? <Chip text={hiddenText} onRemove={props.onShowHiddenColumns} /> : null}
        <span className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onPress={props.onClear}>Clear</Button>
          {readOnly ? null : (
            <Button variant="secondary" size="sm" isDisabled={save.phase === "saving"} onPress={props.onSave}>
              {save.phase === "saving" ? "Saving…" : "Save to view"}
            </Button>
          )}
        </span>
      </div>
      {message ? (
        <p role="alert" className="cl-mono flex items-center gap-2 border border-warn px-3 py-2 text-[11px] text-warn">
          <span>{message}</span>
          {save.phase === "conflict" ? <Button variant="ghost" size="sm" onPress={props.onReload}>Reload</Button> : null}
        </p>
      ) : null}
    </div>
  );
}
```

Chip text for the quick filter equals `filter.label`; the test's `quickFilterIdentity({ …, label: "" })` matches because identity ignores the label.

- [ ] **Step 6: Implement `ArchiveRowDialog.tsx`**

```tsx
import { useState } from "react";
import type { QueryRow } from "#/api/bases";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";

export interface ArchiveRowDialogProps {
  row: QueryRow | null;
  onCancel(): void;
  onConfirm(row: QueryRow): Promise<void>;
}

export function ArchiveRowDialog({ row, onCancel, onConfirm }: ArchiveRowDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { if (pending) return; setError(null); onCancel(); };
  const confirm = async () => {
    if (!row) return;
    setPending(true); setError(null);
    try { await onConfirm(row); } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The page could not be archived.");
    } finally { setPending(false); }
  };
  return (
    <Dialog
      isOpen={row !== null}
      onOpenChange={(open) => { if (!open) close(); }}
      title="Archive page"
      description={row ? (row.title ?? row.path) : ""}
      isDismissable={!pending}
      footer={
        <>
          <Button variant="secondary" onPress={close} isDisabled={pending}>Cancel</Button>
          <Button variant="danger" onPress={() => void confirm()} isDisabled={pending}>{pending ? "Archiving…" : "Confirm archive"}</Button>
        </>
      }
    >
      <div className="space-y-2 text-sm">
        <p>This page will be removed from normal views.</p>
        <p>Inbound links remain byte-identical and become unresolved after archival.</p>
        <p>You can restore this page from the Rubbish Bin.</p>
        {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
      </div>
    </Dialog>
  );
}
```

The dialog closes when `onConfirm` resolves: the parent sets `row` to `null` in its own success path (Step 7).

- [ ] **Step 7: Wire `BaseTableView.tsx`**

1. Add the new optional props (Interfaces) and destructure them with defaults (`overrides = EMPTY_OVERRIDES`, `overridesSave = { phase: "idle" }`).
2. Columns: after `const columns = …`, add `const visibleColumns = columns.filter((c) => !overrides.hiddenColumns.includes(c));` and use `visibleColumns` everywhere `columns` was used for rendering (`TableHeader` map, cell map, `isRowHeader={column === visibleColumns[0]}`, `editableColumns`). Keep `columns` for `evaluationIdentity`, and add `hidden: overrides.hiddenColumns` and `groupOverride: overrides.group ?? null` to that identity object.
3. Effective grouping: `const effectiveGroup = overrides.group ? (overrides.group.kind === "by" ? overrides.group.field : undefined) : view?.group_by ?? undefined;`.
4. Header: wrap the `<Column>` children render-prop output. Inside `{({ sortDirection }) => (…)}` return:

```tsx
readOnly ? (
  <span className="inline-flex items-center gap-1">{label}{arrow}</span>
) : (
  <BaseHeaderMenu
    column={column}
    label={displayLabelForColumn(column)}
    allowsSorting={allowsSorting}
    groupable={groupableColumn(column)}
    groupedByThis={effectiveGroup === column}
    hideable={column !== "title" && visibleColumns.length > 1}
    presets={headerFilterPresets(column, quickFilterType(column, properties.get(column)), properties.get(column), displayLabelForColumn(column))}
    onSortChange={onSortChange}
    onAddQuickFilter={onAddQuickFilter ?? noop}
    onSetGroup={onSetGroup ?? noop}
    onHideColumn={onHideColumn ?? noop}
  >
    <span className="inline-flex items-center gap-1">{label}{arrow}</span>
  </BaseHeaderMenu>
)
```

with `const noop = () => {};` at module scope and

```ts
const GROUPABLE_SYSTEM: Record<string, true> = { kind: true, project: true, created_at: true, updated_at: true, journal_date: true };
const groupableColumn = (column: string) =>
  SYSTEM_COLUMNS[column] !== undefined ? GROUPABLE_SYSTEM[column] === true : canGroup(properties.get(column)?.type);
```

(import `canGroup` from `./definition-model`). RAC applies the column's sort press to the whole header; the `⋯` button's own press stops propagation, so the two coexist — verify in the test.

5. Row: give `<Row className="group border-b …">`. Wrap every cell's content:

```tsx
<Cell key={column} className="px-1 py-0.5 align-top">
  <CellContextMenu
    row={row}
    column={column}
    label={displayLabelForColumn(column)}
    type={quickFilterType(column, properties.get(column))}
    definition={properties.get(column)}
    value={(row.columns as Record<string, CellValue>)[column]}
    readOnly={readOnly}
    actions={rowActions}
    onAddQuickFilter={onAddQuickFilter}
    onCopyValue={onCopyValue}
  >
    {existingCellContent}
    {column === visibleColumns[0] ? <RowActionsButton row={row} readOnly={readOnly} actions={rowActions} /> : null}
  </CellContextMenu>
</Cell>
```

where `rowActions: RowMenuActions = { onOpenPage, onOpenPageInNewTab, onCopyWikilink, onDuplicateRow, onArchiveRow: (r) => setArchiveTarget(r) }` (memoised). The title `<button>`/`<span>` and `EditableCell` keep their `block w-full` styling; give the wrapper div `flex-1 min-w-0` on its first child via `[&>*:first-child]:min-w-0 [&>*:first-child]:flex-1`.

6. Register title buttons for focus restoration: `const titleButtons = useRef(new Map<string, HTMLButtonElement>());` and on the title `<button>` merge the existing `ref` logic with a callback that sets/deletes `titleButtons.current` by `String(row.id)` (compose: call the existing ref target too). Add to the imperative handle:

```ts
focusRow(rowId) {
  const button = titleButtons.current.get(rowId);
  if (!button) return false;
  button.focus();
  return true;
}
```

7. Archive flow: `const [archiveTarget, setArchiveTarget] = useState<QueryRow | null>(null);` `const [pendingFocusRowId, setPendingFocusRowId] = useState<string | undefined>();` Render `<ArchiveRowDialog row={archiveTarget} onCancel={() => setArchiveTarget(null)} onConfirm={async (r) => { if (!onArchiveRow) return; const ids = rowsInOrder.map((x) => String(x.id)); const i = ids.indexOf(String(r.id)); const next = ids[i + 1] ?? ids[i - 1]; await onArchiveRow(r); setPendingFocusRowId(next ?? "__entry__"); setArchiveTarget(null); }} />` where `rowsInOrder` is the flat rows or the concatenation of group rows. Add a `useEffect` on `[output, pendingFocusRowId]`: when set and the archived row is no longer present, `focusRow(id) || focusEntry()`, then clear. Only render the dialog when `!readOnly && onArchiveRow`.

8. Strip: render `<ViewOverridesStrip … />` directly after the toolbar `<div>` (before `memberDraftOpen`), passing `labelFor={displayLabelForColumn}`, `readOnly`, `save={overridesSave}`, and the handlers (`onSortChange`, `onRemoveQuickFilter ?? noop`, `onSetGroup ?? noop`, `onShowHiddenColumns ?? noop`, `onClearOverrides ?? noop`, `onSaveOverrides ?? noop`, `onReloadDefinition ?? noop`). Render `rowActionError` as `<p role="alert" className="cl-mono border border-warn px-3 py-2 text-[11px] text-warn">{rowActionError}</p>` next to `viewError`.

9. Grouped rendering uses the server's output shape; nothing else changes.

- [ ] **Step 8: Run the new and existing view tests**

Run: `cd ui && bun run test src/components/bases/__tests__/BaseTableMenus.test.tsx src/components/bases/__tests__/BaseTableView.test.tsx src/components/bases/__tests__/BaseTable.test.tsx src/editor/elements`
Expected: PASS. If an existing test queried the title cell by exact text and now sees the `⋯` button's label in the same cell, prefer tightening the query (`getByRole("button", { name: "The Book…" })`) over changing the component.

- [ ] **Step 9: Typecheck, lint, format touched files, commit**

```bash
cd ui && bun run typecheck && bun run lint && bunx biome check --write src/components/bases/BaseHeaderMenu.tsx src/components/bases/BaseRowMenu.tsx src/components/bases/ViewOverridesStrip.tsx src/components/bases/ArchiveRowDialog.tsx src/components/bases/BaseTableView.tsx src/components/bases/__tests__/BaseTableMenus.test.tsx
cd .. && git add ui/src/components/bases && git commit -m "feat(bases): header, cell and row menus with an overrides strip"
```

---

### Task 6: Row actions — open in new tab, copy, duplicate, archive

**Files:**
- Create: `ui/src/components/bases/useRowActions.ts`
- Modify: `ui/src/components/bases/useBaseTableController.ts`
- Test: `ui/src/components/bases/__tests__/useRowActions.test.tsx` (new), `ui/src/components/bases/__tests__/useBaseTableController.test.tsx` (mocks + one integration test)

**Interfaces:**
- Consumes: `useOpenTab` (`#/hooks/useOpenTab`), `useCopyToClipboard` (`#/hooks/useCopyToClipboard`), `useArchivePage` (`#/api/pages`), `useCreateBaseMember`, `decodeBaseMemberDiagnostics` (`#/api/bases`), `fetchClient` (`#/api/client`), `formatCellValue` (`./cells/types`), `isApiConflict`.
- Produces:

```ts
export interface RowActionsOptions {
  slug: string;
  activeView: string;
  definition: BaseDetailResponse | undefined;
  capability: BaseMemberCapability | undefined;
  embedFilter: BaseFilter | undefined;
  refetchView(): Promise<{ output: QueryOutput | undefined }>;
  refetchDefinition(): Promise<unknown>;
}
export interface RowActionsModel {
  openInNewTab(path: string): void;
  copyWikilink(row: QueryRow): void;
  copyValue(value: CellValue): void;
  duplicate(row: QueryRow): Promise<void>;
  archive(row: QueryRow): Promise<void>;
  notice: string | undefined;
  error: string | undefined;
}
export function useRowActions(options: RowActionsOptions): RowActionsModel
export function wikilinkFor(row: QueryRow): string   // `[[Title]]` or `[[stem]]`
export function duplicateFields(capability, properties: PageBaseProperty[], row, tags: string[] | null | undefined): Record<string, unknown>
```

- [ ] **Step 1: Failing tests**

`ui/src/components/bases/__tests__/useRowActions.test.tsx`:

```tsx
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseMemberCapability, QueryRow } from "#/api/bases";

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  copy: vi.fn().mockResolvedValue(undefined),
  archive: vi.fn(),
  createMember: vi.fn(),
  get: vi.fn(),
}));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => mocks.openTab }));
vi.mock("#/hooks/useCopyToClipboard", () => ({ useCopyToClipboard: () => ({ copied: false, copy: mocks.copy }) }));
vi.mock("#/api/pages", () => ({ useArchivePage: () => ({ mutateAsync: mocks.archive, isPending: false }) }));
vi.mock("#/api/client", () => ({ fetchClient: { GET: mocks.get } }));
vi.mock("#/api/bases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#/api/bases")>()),
  useCreateBaseMember: () => ({ mutateAsync: mocks.createMember, isPending: false }),
}));

import { duplicateFields, useRowActions, wikilinkFor } from "#/components/bases/useRowActions";

const row: QueryRow = { id: "01", path: "books/book.md", title: "Book A", kind: "BOOK", project: "shelf", columns: { status: "reading" } };
const capability: BaseMemberCapability = {
  view: "Continues", enabled: true, blockers: [],
  fields: [
    { field: "status", membership: true, view: true, embed: false, implied: { kind: "fixed", value: "reading" } },
    { field: "rating", membership: false, view: false, embed: false, implied: null },
  ],
};

function options(overrides: Partial<Parameters<typeof useRowActions>[0]> = {}) {
  return {
    slug: "reading",
    activeView: "Continues",
    definition: { slug: "reading", revision: "r1", name: "Reading", properties: [{ key: "status", definition: { type: "select" } }, { key: "rating", definition: { type: "number" } }], views: [], diagnostics: [], member_creation: [] },
    capability,
    embedFilter: undefined,
    refetchView: vi.fn().mockResolvedValue({ output: { shape: "flat", rows: [{ ...row, id: "02" }], total: 1, aggregates: [] } }),
    refetchDefinition: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("wikilinkFor", () => {
  it("uses the title, falling back to the path stem", () => {
    expect(wikilinkFor(row)).toBe("[[Book A]]");
    expect(wikilinkFor({ ...row, title: null })).toBe("[[book]]");
  });
});

describe("duplicateFields", () => {
  it("layers implications, declared values, kind, project and tags", () => {
    const fields = duplicateFields(
      capability,
      [
        { key: "status", present: true, value: "queued", compatibility: "compatible", definition: null, declarations: [], patchable: true, blockers: [] },
        { key: "rating", present: false, value: null, compatibility: "compatible", definition: null, declarations: [], patchable: true, blockers: [] },
      ],
      row,
      ["fiction"],
    );
    expect(fields).toEqual({ status: "queued", kind: "BOOK", project: "shelf", tags: ["fiction"] });
  });
});

describe("useRowActions", () => {
  it("opens in a new tab and copies", async () => {
    const { result } = renderHook(() => useRowActions(options()));
    act(() => result.current.openInNewTab("books/book.md"));
    expect(mocks.openTab).toHaveBeenCalledWith("page", "books/book.md", undefined, { mode: "new" });
    await act(async () => result.current.copyWikilink(row));
    expect(mocks.copy).toHaveBeenCalledWith("[[Book A]]");
    await act(async () => result.current.copyValue(["a", "b"]));
    expect(mocks.copy).toHaveBeenCalledWith("a, b");
  });

  it("duplicates through the member endpoint and reports the notice", async () => {
    mocks.get.mockImplementation(async (path: string) =>
      path.includes("/properties")
        ? { data: { properties: [{ key: "status", present: true, value: "reading", compatibility: "compatible", definition: null, declarations: [], patchable: true, blockers: [] }] } }
        : { data: { meta: { tags: ["fiction"] } } },
    );
    mocks.createMember.mockResolvedValue({ id: "02", path: "books/book-copy.md", title: "Book A (copy)", revision: "r2" });
    const opts = options();
    const { result } = renderHook(() => useRowActions(opts));
    await act(async () => result.current.duplicate(row));
    expect(mocks.createMember).toHaveBeenCalledWith({
      params: { path: { slug: "reading" } },
      body: { base_revision: "r1", view: "Continues", title: "Book A (copy)", fields: { status: "reading", kind: "BOOK", project: "shelf", tags: ["fiction"] } },
    });
    expect(opts.refetchView).toHaveBeenCalled();
    expect(result.current.notice).toBe("Duplicated as “Book A (copy)”.");
  });

  it("reports duplicate failures with diagnostics", async () => {
    mocks.get.mockResolvedValue({ data: { properties: [], meta: {} } });
    mocks.createMember.mockRejectedValue({ status: 400, error: "member does not match", detail: { diagnostics: [{ scope: "membership", message: "kind must be BOOK", field: "kind", filter_path: null }] } });
    const { result } = renderHook(() => useRowActions(options()));
    await act(async () => result.current.duplicate(row));
    expect(result.current.error).toBe("member does not match — kind must be BOOK");
  });

  it("archives and refetches", async () => {
    mocks.archive.mockResolvedValue({});
    const opts = options();
    const { result } = renderHook(() => useRowActions(opts));
    await act(async () => result.current.archive(row));
    expect(mocks.archive).toHaveBeenCalledWith({ params: { path: { path: "books/book.md" } } });
    expect(opts.refetchView).toHaveBeenCalled();
  });
});
```

Adjust the rejected-error shape to whatever `decodeBaseMemberDiagnostics` and `formatApiError` read (`ui/src/api/bases.ts:107`, `ui/src/api/error.ts:29`) so the message assertion is exact; the joined format is `${formatApiError(error, "Duplicate failed.")} — ${diagnostics.map(d => d.message).join("; ")}` (omit the dash part when there are no diagnostics).

- [ ] **Step 2: Implement `useRowActions.ts`**

```ts
import { useCallback, useState } from "react";
import {
  type BaseDetailResponse,
  type BaseFilter,
  type BaseMemberCapability,
  decodeBaseMemberDiagnostics,
  type QueryOutput,
  type QueryRow,
  useCreateBaseMember,
} from "#/api/bases";
import { fetchClient } from "#/api/client";
import { formatApiError, isApiConflict } from "#/api/error";
import { useArchivePage } from "#/api/pages";
import type { components } from "#/api/schema";
import { useCopyToClipboard } from "#/hooks/useCopyToClipboard";
import { useOpenTab } from "#/hooks/useOpenTab";
import { type CellValue, formatCellValue } from "./cells/types";

type PageBaseProperty = components["schemas"]["PageBaseProperty"];

export function wikilinkFor(row: QueryRow): string {
  const stem = row.path.split("/").pop()?.replace(/\.md$/, "") ?? row.path;
  return `[[${row.title ?? stem}]]`;
}

export function duplicateFields(
  capability: BaseMemberCapability | undefined,
  properties: PageBaseProperty[],
  row: QueryRow,
  tags: string[] | null | undefined,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const requirement of capability?.fields ?? []) {
    if (requirement.implied?.kind === "fixed") fields[requirement.field] = requirement.implied.value;
  }
  for (const property of properties) {
    if (property.present && property.value !== null && property.value !== undefined) fields[property.key] = property.value;
  }
  fields.kind = row.kind;
  if (row.project) fields.project = row.project;
  if (tags && tags.length > 0) fields.tags = tags;
  return fields;
}

export interface RowActionsOptions { /* as in Interfaces */ }
export interface RowActionsModel { /* as in Interfaces */ }

export function useRowActions(options: RowActionsOptions): RowActionsModel {
  const { slug, activeView, definition, capability, embedFilter, refetchView, refetchDefinition } = options;
  const openTab = useOpenTab();
  const { copy } = useCopyToClipboard();
  const archivePage = useArchivePage();
  const { mutateAsync: createMember } = useCreateBaseMember();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  const openInNewTab = useCallback((path: string) => openTab("page", path, undefined, { mode: "new" }), [openTab]);
  const copyWikilink = useCallback((row: QueryRow) => { void copy(wikilinkFor(row)); }, [copy]);
  const copyValue = useCallback((value: CellValue) => { void copy(formatCellValue(value)); }, [copy]);

  const duplicate = useCallback(async (row: QueryRow) => {
    setNotice(undefined); setError(undefined);
    if (!definition) return;
    try {
      const [propertiesResult, pageResult] = await Promise.all([
        fetchClient.GET("/api/vault/pages/by-id/{uuid}/properties", { params: { path: { uuid: row.id } } }),
        fetchClient.GET("/api/vault/pages/{path}", { params: { path: { path: row.path } } }),
      ]);
      if (propertiesResult.error) throw propertiesResult.error;
      if (pageResult.error) throw pageResult.error;
      const title = `${row.title ?? row.path} (copy)`;
      const created = await createMember({
        params: { path: { slug } },
        body: {
          base_revision: definition.revision,
          view: activeView,
          title,
          fields: duplicateFields(capability, propertiesResult.data?.properties ?? [], row, pageResult.data?.meta.tags),
          ...(embedFilter === undefined ? {} : { embed_filter: embedFilter }),
        },
      });
      const refreshed = await refetchView();
      const included = refreshed.output ? outputContains(refreshed.output, created.id) : true;
      setNotice(included ? `Duplicated as “${created.title}”.` : `Duplicated as “${created.title}”, but it is not included in the current view.`);
    } catch (failure) {
      if (isApiConflict(failure)) { await refetchDefinition(); setError("The base changed elsewhere; try again."); return; }
      const diagnostics = decodeBaseMemberDiagnostics(failure);
      const base = formatApiError(failure, "Duplicate failed.");
      setError(diagnostics.length > 0 ? `${base} — ${diagnostics.map((d) => d.message).join("; ")}` : base);
    }
  }, [activeView, capability, createMember, definition, embedFilter, refetchDefinition, refetchView, slug]);

  const archive = useCallback(async (row: QueryRow) => {
    setNotice(undefined); setError(undefined);
    try {
      await archivePage.mutateAsync({ params: { path: { path: row.path } } });
    } catch (failure) {
      throw new Error(formatApiError(failure, "The page could not be archived."));
    }
    await refetchView();
  }, [archivePage.mutateAsync, refetchView]);

  return { openInNewTab, copyWikilink, copyValue, duplicate, archive, notice, error };
}
```

`outputContains` exists in `useBaseTableController.ts` — move it to `view-overrides.ts`? No: export it from a tiny new module `ui/src/components/bases/query-output.ts` (`export function outputContains(output: QueryOutput, id: string): boolean`) and import it from both files. If the `fetchClient.GET` path literal for the page is typed differently (check `"/api/vault/pages/{path}"` exists in `schema.d.ts` paths — it does, `get: operations["get_page"]`), keep as written. `useArchivePage`'s `mutateAsync` identity: `archivePage.mutateAsync` is stable (see memory on TanStack mutation identity).

- [ ] **Step 3: Controller integration**

In `useBaseTableController.ts`:

- Call `useRowActions({ slug, activeView, definition: detail.data, capability: memberCapability, embedFilter: mode === "embedded" ? effectiveFilter : undefined, refetchView: async () => mode === "embedded" ? { output: (await evaluationRefetch()).data?.output } : { output: (await savedViewRefetch()).data }, refetchDefinition: detailRefetch })` (memoise the two refetch callbacks).
- Model gains `onOpenPageInNewTab: rowActions.openInNewTab`, `onCopyWikilink: rowActions.copyWikilink`, `onCopyValue: rowActions.copyValue`, `onDuplicateRow: (row) => void rowActions.duplicate(row)`, `onArchiveRow: rowActions.archive`, `rowActionError: rowActions.error`; fold `rowActions.notice` into `memberNotice` (`visibleMemberNotice ?? rowActions.notice`).
- Add the model fields to `BaseTableControllerModel`.
- `useBaseTableController.test.tsx`: add `vi.mock("#/hooks/useCopyToClipboard", …)`, `vi.mock("#/api/pages", …)`, `vi.mock("#/api/client", …)` as in the hook test, and one integration test: `onDuplicateRow` posts with `embed_filter` equal to the **effective** filter in embedded mode (fence + one quick filter → `{ all: [...] }`). Update `BaseTable.test.tsx`'s mocks the same way.

- [ ] **Step 4: Run, typecheck, lint, format, commit**

Run: `cd ui && bun run test src/components/bases src/editor/elements && bun run typecheck && bun run lint`

```bash
git add ui/src/components/bases ui/src/components/bases/__tests__
git commit -m "feat(bases): row actions — open in new tab, copy wikilink, duplicate, archive"
```

---

### Task 7: Documentation and full gates

**Files:**
- Modify: `ui/src/docs/content/bases.mdx` ("Web UI, saved tables, and inline editing" section, line ~377; "Embed a Base in a Folio" ~395)

- [ ] **Step 1: Document the menus**

Replace the sentence "…and lets you click a column header to apply a temporary ascending or descending sort override." with "…and lets you click a column header to apply a temporary ascending or descending sort override." followed by a new subsection before "### Add members inline":

```mdx
### Column, cell, and row menus

Every column header has a `⋯` menu (also on right-click): **Sort ascending**, **Sort descending**, **Filter ▸** presets (is empty / is not empty, checked / unchecked, the relative-date presets, and up to twelve declared select options), **Group by** / **Ungroup**, and **Hide column**. The title column and the last visible column cannot be hidden.

Right-click any cell (or press <kbd>Shift</kbd>+<kbd>F10</kbd> / <kbd>⌃</kbd><kbd>Enter</kbd> on a focused cell control) for a quick filter derived from the cell's value — `Status is reading`, `Tags has fiction`, `Due is 2026-08-28`, `Done is checked`, `Author is empty` — a **Filter by date ▸** submenu on date columns, **Copy value**, and the row actions: **Open**, **Open in new tab**, **Copy wikilink**, **Duplicate**, and **Archive…**. A ghost `⋯` button in the first cell opens the row actions alone.

Sort, quick filters, grouping, and hidden columns are **view overrides**: they apply to the table you are looking at and appear as removable chips in a strip under the toolbar. **Clear** drops them all; **Save to view** writes them into the saved view (`filter`, `sort`, `group_by`, `columns`) through the revision-guarded definition update, so a base edited elsewhere in the meantime is reported instead of overwritten. Switching views drops the overrides.

**Duplicate** creates a new page through the member endpoint with the same declared properties, kind, project, and tags, titled `<title> (copy)`; the body is not copied, and the new page must still match the view. **Archive…** asks for confirmation and moves the page to the Rubbish Bin; focus returns to the next row.
```

Under "Embed a Base in a Folio", add one sentence: "Embedded tables carry the same menus; overrides are yours as a reader and are not written into the fence, while **Save to view** still updates the base definition."

- [ ] **Step 2: Full gates**

```bash
cargo fmt --check && cargo clippy --all-targets -- -D warnings 2>&1 | tail -3 && cargo test 2>&1 | grep -E "^test result|FAILED|panicked"
cd ui && bun run typecheck && bun run lint && bun run test 2>&1 | tail -15
```

Expected: everything green except the pre-existing failures already known on develop (`Sheaf.test.tsx` ×2, `InscribeModal.test.tsx` ×2). Report the exact numbers.

- [ ] **Step 3: Commit**

```bash
git add ui/src/docs/content/bases.mdx
git commit -m "docs(bases): column, cell and row menus; view overrides"
```
