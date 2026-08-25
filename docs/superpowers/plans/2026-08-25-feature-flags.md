# Startup Feature Flags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add startup-controlled Academic and Feeds feature flags that disable every runtime and UI surface while preserving existing behavior by default.

**Architecture:** `Settings` resolves one immutable `FeatureFlags` snapshot. Router construction, an optional `FeedRuntime`, diagnostics, runtime OpenAPI, and a UI feature provider all consume that snapshot. Disabled feature routers are absent; disabled UI routes render the shared not-found surface without mounting feature components.

**Tech Stack:** Rust 2024, Axum 0.8, config 0.15, Utoipa 5, Tokio, React 19, TanStack Query and Router, TypeScript, Vitest, React Testing Library, Biome.

**Spec:** `docs/superpowers/specs/2026-08-25-feature-flags-design.md`

## Global Constraints

- `[features].academic` and `[features].feeds` are startup-only booleans.
- Both flags default to `true` when `[features]` or either key is absent.
- Existing `CLEPSYDRA__*` environment precedence applies unchanged.
- Disabled API paths return the standard unknown-route `404`.
- Disabled Feeds must not open or create `.clepsydra/feeds.db`, create its HTTP client, read `feeds.md`, notify feed work, or start its scheduler.
- Disabling a feature never modifies or deletes existing feature data.
- Runtime OpenAPI reflects enabled features; build-time `ApiDoc::openapi()` remains the complete superset.
- Capability lookup failure hides optional UI surfaces.
- No runtime toggle endpoint or settings UI.

---

### Task 1: Configuration Model and User-Facing Configuration

**Files:**
- Modify: `src/lib.rs:44-104` and `src/lib.rs:253-305`
- Modify: `src/config_command.rs:12-55` and its tests near `src/config_command.rs:458-504`
- Modify: `ui/src/docs/content/configuration.mdx:90-145` and `ui/src/docs/content/configuration.mdx:220-228`
- Test: `src/lib.rs` module `settings_tests`

**Interfaces:**
- Produces: `pub struct FeatureFlags { pub academic: bool, pub feeds: bool }`
- Produces: `impl Default for FeatureFlags` returning both fields as `true`
- Produces: `pub features: FeatureFlags` on `Settings`
- Consumes: the existing `Config` precedence `defaults < file < CLEPSYDRA__* environment`

- [ ] **Step 1: Write failing default, file, and environment tests**

Add focused tests to `settings_tests`:

```rust
fn assert_feature_defaults(features: FeatureFlags) {
    assert!(features.academic);
    assert!(features.feeds);
}

#[test]
fn settings_without_features_use_enabled_defaults() {
    let tmp = tempfile::TempDir::new().unwrap();
    let config = tmp.path().join("config.toml");
    std::fs::write(&config, "").unwrap();

    assert_feature_defaults(Settings::load_from(&config).unwrap().features);
}

#[test]
fn settings_read_independent_feature_values() {
    let tmp = tempfile::TempDir::new().unwrap();
    let config = tmp.path().join("config.toml");
    std::fs::write(&config, "[features]\nacademic = false\nfeeds = true\n").unwrap();

    let features = Settings::load_from(&config).unwrap().features;
    assert!(!features.academic);
    assert!(features.feeds);
}

#[serial_test::serial]
#[test]
fn feature_environment_override_wins_over_file() {
    let _guard = EnvGuard::set("CLEPSYDRA__FEATURES__FEEDS", "false");
    let tmp = tempfile::TempDir::new().unwrap();
    let config = tmp.path().join("config.toml");
    std::fs::write(&config, "[features]\nfeeds = true\n").unwrap();

    assert!(!Settings::load_from(&config).unwrap().features.feeds);
}
```

Extend `create_writes_literate_comment_only_template` to require `# [features]`, `# academic = true`, and `# feeds = true`. Extend `template_documents_precedence_and_tls_pairing` to require both `CLEPSYDRA__FEATURES__ACADEMIC` and `CLEPSYDRA__FEATURES__FEEDS`.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
cargo test settings_tests::settings_without_features_use_enabled_defaults
cargo test settings_tests::settings_read_independent_feature_values
cargo test settings_tests::feature_environment_override_wins_over_file
cargo test config_command::tests::create_writes_literate_comment_only_template
```

Expected: compilation or assertion failures because `FeatureFlags`, `Settings.features`, and template lines do not exist.

- [ ] **Step 3: Implement the typed configuration snapshot**

Add:

```rust
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
pub struct FeatureFlags {
    #[serde(default = "enabled")]
    pub academic: bool,
    #[serde(default = "enabled")]
    pub feeds: bool,
}

const fn enabled() -> bool { true }

impl Default for FeatureFlags {
    fn default() -> Self {
        Self { academic: true, feeds: true }
    }
}
```

Add `#[serde(default)] pub features: FeatureFlags` to `Settings`. Do not add separate feature defaults to the `Config::builder`; Serde defaults must cover both an absent section and absent individual fields.

Insert this commented template section before `[feeds]`:

```toml
# [features]
# Enable Academic routes and UI. Default: true.
# academic = true
# Enable Feeds routes, UI, storage, networking, and scheduler. Default: true.
# feeds = true
# Environment overrides: CLEPSYDRA__FEATURES__ACADEMIC and CLEPSYDRA__FEATURES__FEEDS.
```

Update the application configuration example, table, and environment examples in `configuration.mdx`. State that changes require restart and that disabling a feature preserves its files.

- [ ] **Step 4: Run focused tests and verify success**

Run:

```bash
cargo test settings_tests
cargo test config_command::tests
```

Expected: all settings and config-command tests pass.

- [ ] **Step 5: Commit the configuration contract**

```bash
git add src/lib.rs src/config_command.rs ui/src/docs/content/configuration.mdx
git commit -m "feat: add startup feature configuration"
```

---

### Task 2: Optional Feed Runtime and Startup Lifecycle

**Files:**
- Create: `src/feeds/runtime.rs`
- Modify: `src/feeds/mod.rs`
- Modify: `src/api/mod.rs:56-123`
- Modify: `src/lib.rs:561-723`, `src/lib.rs:799-835`, and `src/lib.rs:987-1025`
- Modify: `src/api/feeds.rs`
- Modify: `src/feeds/scheduler.rs`
- Modify constructors in `src/api/base_members.rs`, `tests/support/mod.rs`, `tests/academic_dedup_test.rs`, `tests/api_agenda_test.rs`, `tests/api_tasks_test.rs`, `tests/block_ref_resolution_test.rs`, `tests/e2e_block_refs_test.rs`, `tests/e2e_tasks_journal_test.rs`, and `tests/e2e_test.rs`
- Test: `src/lib.rs` startup and watcher test modules

**Interfaces:**
- Consumes: `FeatureFlags` and `FeedsSettings` from Task 1
- Produces: `pub struct FeedRuntime` containing the complete feed store, client, synchronization primitives, test hooks, and settings
- Produces: `pub fn FeedRuntime::open(vault_root: &Path, settings: &FeedsSettings) -> Result<Self, Box<dyn Error>>`
- Produces: `pub feed_runtime: Option<crate::feeds::runtime::FeedRuntime>` on `AppState`
- Produces: `pub(crate) fn AppState::feed_runtime(&self) -> &FeedRuntime`, with an invariant message that feed routes and scheduler are mounted only when the runtime exists
- Produces: `build_app_state_with_settings(vault_root: &Path, feed_settings: &FeedsSettings, features: FeatureFlags)`

- [ ] **Step 1: Write failing disabled-runtime and watcher tests**

Add tests that build a fresh vault with `FeatureFlags { academic: true, feeds: false }`:

```rust
#[tokio::test]
async fn disabled_feeds_create_no_runtime_or_database() {
    let tmp = tempfile::TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    crate::vault::init::init_vault(&root).unwrap();

    let state = build_app_state_with_settings(
        &root,
        &FeedsSettings::default(),
        FeatureFlags { academic: true, feeds: false },
    ).await.unwrap();

    assert!(state.feed_runtime.is_none());
    assert!(!root.join(".clepsydra/feeds.db").exists());
}

#[tokio::test]
async fn disabled_feeds_ignore_manifest_watcher_batches() {
    let (state, _tmp) = state_test_support::make_state_with_features(
        FeatureFlags { academic: true, feeds: false },
    ).await;
    let event = ChangeEvent::Upsert(VaultPath::new("feeds.md").unwrap());

    notify_feed_scheduler_from_batch(&state, &[event]);
    assert!(state.feed_runtime.is_none());
}
```

Add a serving test where the serving future completes and no scheduler or manifest reconciliation is required when `feed_runtime` is `None`.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
cargo test disabled_feeds_create_no_runtime_or_database
cargo test disabled_feeds_ignore_manifest_watcher_batches
cargo test serving_without_feed_runtime_completes_without_scheduler
```

Expected: compilation failures because the feature-aware state builder and optional runtime do not exist.

- [ ] **Step 3: Introduce `FeedRuntime` and migrate all consumers**

Move these `AppState` fields into `FeedRuntime`: `feeds`, `feed_client`, `feed_discovery_semaphore`, `feed_refresh`, `feed_manifest_diagnostics`, `feed_manifest_lock`, all three feed test hooks, and `feed_settings`.

Implement `FeedRuntime::open` so allocation is atomic from the caller’s perspective:

```rust
pub fn open(vault_root: &Path, settings: &FeedsSettings) -> Result<Self, Box<dyn Error>> {
    let feeds = FeedStoreHandle::open(&vault_root.join(".clepsydra/feeds.db"))?;
    let feed_client = CheckedHttpClient::new(settings.max_response_bytes)?;
    Ok(Self {
        feeds,
        feed_client,
        feed_discovery_semaphore: Semaphore::new(settings.fetch_concurrency.max(1)),
        feed_refresh: Notify::new(),
        feed_manifest_diagnostics: RwLock::new(Vec::new()),
        feed_manifest_lock: Mutex::new(()),
        feed_settings: settings.clone(),
        // cfg(test) hooks initialize to None
    })
}
```

`build_app_state` uses `FeatureFlags::default()`. Replace `build_app_state_with_feeds` with `build_app_state_with_settings`; do not retain an alias. Construct `Some(FeedRuntime::open(...))` only when `features.feeds` is true.

Use LSP references before replacing each moved field. Migrate feed handlers and scheduler code to `state.feed_runtime().<field>`. Migrate every listed `AppState` literal to one `feed_runtime: Some(FeedRuntime::open(...).unwrap())` field and remove the old feed fields.

Change watcher notification to:

```rust
let Some(runtime) = state.feed_runtime.as_ref() else { return; };
if batch_touches_manifest(batch) {
    runtime.feed_refresh.notify_one();
}
```

Replace `serve_with_feed_scheduler` with `serve_with_optional_feed_scheduler`. If the runtime is absent, return `serving.await` directly. If present, reconcile, spawn, await serving, then cancel and join exactly as today.

- [ ] **Step 4: Run runtime, feed API, and integration tests**

Run:

```bash
cargo test disabled_feeds
cargo test watcher_
cargo test serving_
cargo test --test api_feeds
cargo test feeds::
cargo test --test e2e_test
```

Expected: all selected tests pass, and disabled state construction leaves no feed database.

- [ ] **Step 5: Commit the runtime boundary**

```bash
git add src/feeds/runtime.rs src/feeds/mod.rs src/api/mod.rs src/lib.rs src/api/feeds.rs src/feeds/scheduler.rs src/api/base_members.rs tests
git commit -m "feat: make feed runtime optional"
```

---

### Task 3: Capability Endpoint, Conditional Routers, and Runtime OpenAPI

**Files:**
- Create: `src/api/features.rs`
- Modify: `src/api/mod.rs:1-25` and router functions near `src/api/mod.rs:181-234`
- Modify: `src/api/openapi.rs:59-450`
- Modify: `src/lib.rs:539-559` and `src/lib.rs:1004-1025`
- Modify: `tests/api_test.rs`
- Modify: `tests/openapi_contract.rs`
- Modify: `ui/src/api/schema.d.ts` using the full build-time OpenAPI document
- Modify: `ui/src/docs/content/api-reference.mdx`

**Interfaces:**
- Consumes: `AppState.features: FeatureFlags` and optional feed runtime from Tasks 1–2
- Produces: `GET /api/features` returning `FeatureFlagsResponse { academic: bool, feeds: bool }`
- Produces: `api_router_with_archive_limit(archive_body_limit, archive_view_config, features)`
- Produces: `openapi::document(features: FeatureFlags) -> utoipa::openapi::OpenApi`
- Produces: `openapi::router<S>(features: FeatureFlags) -> Router<S>`

- [ ] **Step 1: Write failing HTTP and OpenAPI tests**

Add router tests for all four flag combinations. Core assertions:

```rust
let disabled = FeatureFlags { academic: false, feeds: false };
let app = build_test_router_with_features(disabled).await;
assert_eq!(get(&app, "/api/features").await.status(), StatusCode::OK);
assert_eq!(get(&app, "/api/vault/academic/works").await.status(), StatusCode::NOT_FOUND);
assert_eq!(get(&app, "/api/vault/feeds").await.status(), StatusCode::NOT_FOUND);
```

Deserialize the capability body and assert exact booleans. Also assert an enabled Academic request and enabled Feeds request no longer return routing `404`.

Add OpenAPI tests:

```rust
let disabled = openapi::document(FeatureFlags { academic: false, feeds: false });
assert!(disabled.paths.paths.contains_key("/api/features"));
assert!(disabled.paths.paths.keys().all(|path| !path.starts_with("/api/vault/academic")));
assert!(disabled.paths.paths.keys().all(|path| !path.starts_with("/api/vault/feeds")));

let complete = ApiDoc::openapi();
assert!(complete.paths.paths.contains_key("/api/vault/academic/works"));
assert!(complete.paths.paths.contains_key("/api/vault/feeds"));
```

Assert disabled runtime tags contain neither `Academic` nor `Feeds`.

- [ ] **Step 2: Run focused API tests and verify failure**

Run:

```bash
cargo test feature_capabilities
cargo test disabled_feature_routes
cargo test runtime_openapi_filters_disabled_features
```

Expected: failures because the capability route and feature-aware router/document functions do not exist.

- [ ] **Step 3: Implement capability and conditional composition**

Create `features.rs` with a Utoipa-documented handler:

```rust
#[derive(Debug, Serialize, ToSchema)]
pub struct FeatureFlagsResponse {
    pub academic: bool,
    pub feeds: bool,
}

pub async fn get_features(State(state): State<Arc<AppState>>) -> Json<FeatureFlagsResponse> {
    Json(FeatureFlagsResponse {
        academic: state.features.academic,
        feeds: state.features.feeds,
    })
}
```

Store `features` on `AppState`. Build the `/api/vault` router in a mutable local: add Academic only when `features.academic`; add Feeds only when `features.feeds`. Keep `api_router()` as the all-enabled test/default constructor and pass `FeatureFlags::default()`.

Mount `GET /api/features` outside `/api/vault`. Pass `state.features` into both API router construction and `openapi::router`.

Implement `openapi::document` by starting with `ApiDoc::openapi()`, retaining paths that do not start with disabled prefixes, and retaining tags whose names are not disabled. Do not mutate schemas: they remain harmless shared definitions and preserve the build-time client superset.

Document `GET /api/features` under a `## Features` section in `api-reference.mdx` so `docs_api_coverage_test` remains complete.

- [ ] **Step 4: Regenerate the TypeScript schema from the full document**

Start an all-enabled development server and run:

```bash
bun run --cwd ui openapi
```

Verify `ui/src/api/schema.d.ts` contains `/api/features` plus both Academic and Feeds paths. Stop the server after generation.

- [ ] **Step 5: Run API contract tests**

Run:

```bash
cargo test feature_capabilities
cargo test disabled_feature_routes
cargo test runtime_openapi_filters_disabled_features
cargo test --test openapi_contract
cargo test --test docs_api_coverage_test
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit API feature boundaries**

```bash
git add src/api/features.rs src/api/mod.rs src/api/openapi.rs src/lib.rs tests/api_test.rs tests/openapi_contract.rs ui/src/api/schema.d.ts ui/src/docs/content/api-reference.mdx
git commit -m "feat: gate feature APIs and capabilities"
```

---

### Task 4: Feature-Aware Doctor Diagnostics

**Files:**
- Modify: `src/doctor.rs:195-245`
- Modify: academic doctor tests near `src/doctor.rs:1715-1765`

**Interfaces:**
- Consumes: `Settings.features` from Task 1
- Produces: doctor records named `academic` and `feeds` in a `features` section, each reporting `enabled` or `disabled`
- Produces: Academic folder and Zotero checks with `SKIP` status when `features.academic` is false

- [ ] **Step 1: Write failing enabled/disabled diagnostic tests**

Add a fixture config with both flags false and a valid vault. Assert:

```rust
let report = run_with_cwd(cwd, DoctorOpts::default()).await;
assert_record(&report, "features", "academic", Status::Info, "disabled");
assert_record(&report, "features", "feeds", Status::Info, "disabled");
assert_record(&report, "academic", "folders", Status::Skip, "feature disabled");
```

Add the enabled counterpart and assert both feature records say `enabled`; retain the existing Academic folder behavior assertions.

- [ ] **Step 2: Run focused diagnostics tests and verify failure**

Run:

```bash
cargo test doctor::tests::doctor_reports_effective_feature_states
cargo test doctor::tests::disabled_academic_skips_academic_checks
```

Expected: failures because no feature records or disabled skip branch exist.

- [ ] **Step 3: Implement diagnostic reporting and skip behavior**

After top-level settings load, emit two deterministic `INFO` records from effective values. Pass `settings.features.academic` into the Academic check branch. When false, emit the same complete set of Academic record names as the enabled check, each with `SKIP` and `skipped — feature disabled`; do not inspect Academic folders or Zotero paths.

When settings do not load, emit `SKIP` feature records with `skipped — config did not load`, then preserve existing vault-unavailable handling.

- [ ] **Step 4: Run doctor tests and commit**

Run:

```bash
cargo test doctor::tests
```

Expected: all doctor tests pass.

```bash
git add src/doctor.rs
git commit -m "feat: report feature flags in doctor"
```

---

### Task 5: UI Capability Provider, Navigation Filtering, and Route Gates

**Files:**
- Create: `ui/src/api/features.ts`
- Create: `ui/src/components/FeatureFlagsProvider.tsx`
- Create: `ui/src/components/FeatureGate.tsx`
- Create: `ui/src/components/__tests__/FeatureFlagsProvider.test.tsx`
- Modify: `ui/src/routes/__root.tsx`
- Modify: `ui/src/routes/academic.tsx`
- Modify: `ui/src/routes/feeds.tsx`
- Modify: `ui/src/components/codex/viewRegistry.ts` and `ui/src/components/codex/viewRegistry.test.ts`
- Modify: `ui/src/components/codex/DesktopCodexFrame.tsx`
- Modify: `ui/src/components/codex/MobileCodexFrame.tsx`
- Modify: `ui/src/components/codex/commandRegistry.ts` and its tests
- Modify: `ui/src/components/codex/CommandPalette.tsx`
- Modify: `ui/src/components/codex/__tests__/CodexFrame.test.tsx`
- Modify: `ui/src/components/codex/__tests__/CommandPalette.test.tsx`
- Modify: `ui/src/routes/-academic.test.tsx`
- Modify: `ui/src/routes/-feeds.test.tsx`

**Interfaces:**
- Consumes: generated `GET /api/features` schema from Task 3
- Produces: `type FeatureName = "academic" | "feeds"`
- Produces: `type FeatureFlags = Record<FeatureName, boolean>`
- Produces: `useFeatureFlags(): FeatureFlags`
- Produces: `<FeatureGate feature="academic" | "feeds">`
- Produces: `enabledNavItems(items, flags)` and `enabledStaticCommands(flags)` pure filtering functions

- [ ] **Step 1: Write failing provider and pure filtering tests**

Provider tests must prove three states:

```tsx
it("withholds children while capabilities load", () => {
  renderProviderWithPendingRequest();
  expect(screen.queryByText("application")).not.toBeInTheDocument();
  expect(screen.getByRole("status", { name: "Loading features" })).toBeVisible();
});

it("provides server feature values", async () => {
  renderProviderWithResponse({ academic: true, feeds: false });
  expect(await screen.findByText("academic:on feeds:off")).toBeVisible();
});

it("fails closed when capability loading fails", async () => {
  renderProviderWithFailure();
  expect(await screen.findByText("academic:off feeds:off")).toBeVisible();
});
```

Pure registry tests assert Academic and Feeds are removed independently from desktop/mobile arrays and that `nav.academic` plus `library.add-book` are removed when Academic is false. No existing command is Feed-specific, so do not invent one.

- [ ] **Step 2: Write failing frame, palette, and route tests**

Extend frame tests to mock flags and assert disabled labels are absent in both desktop and mobile navigation while ordinal labels for remaining desktop entries are contiguous.

Extend palette tests to assert neither `Open Academic Library` nor `Add book by ISBN` appears when Academic is disabled.

Route tests render each route with its flag false and assert `404 · folio missing` is visible while the Academic/Feeds API mocks have zero calls. Enabled tests retain current route behavior.

- [ ] **Step 3: Run focused UI tests and verify failure**

Run:

```bash
bun run --cwd ui test -- FeatureFlagsProvider viewRegistry CodexFrame CommandPalette -academic -feeds
```

Expected: missing modules, types, and filtering behavior cause failures.

- [ ] **Step 4: Implement capability loading and fail-closed context**

In `api/features.ts`, use the generated client:

```ts
export const DISABLED_FEATURES = { academic: false, feeds: false } as const;
export type FeatureFlags = components["schemas"]["FeatureFlagsResponse"];
export type FeatureName = keyof FeatureFlags;

export function useFeatures() {
  return $api.useQuery("get", "/api/features");
}
```

`FeatureFlagsProvider` renders a full-page accessible loading status while pending. On success it provides returned data. On error it provides `DISABLED_FEATURES` and renders children; it does not retry indefinitely or expose optional links while unknown.

Export the root not-found markup as `NotFoundPage`. Wrap the root application content inside `FeatureFlagsProvider`.

`FeatureGate` reads context and returns `<NotFoundPage />` when its named feature is false. Wrap `AcademicLibrary` and `FeedsPage` at the route component boundary so disabled child components never mount and therefore issue no feature queries.

- [ ] **Step 5: Implement shared registry filtering**

Add `feature: FeatureName | null` to each `ViewDescriptor`; only Academic and Feeds declare a feature. Implement:

```ts
export function enabledNavItems(
  items: readonly CodexView[],
  features: FeatureFlags,
): CodexView[] {
  return items.filter((view) => {
    const feature = VIEW_REGISTRY[view].feature;
    return feature === null || features[feature];
  });
}
```

Both frames call this helper before mapping. Desktop ordinals derive from the filtered array index.

Add `feature?: FeatureName` to static command descriptors. Mark `nav.academic` and `library.add-book` as `academic`. `enabledStaticCommands` filters once before `CommandPalette` maps commands.

- [ ] **Step 6: Run focused UI tests and verify success**

Run:

```bash
bun run --cwd ui test -- FeatureFlagsProvider viewRegistry CodexFrame CommandPalette -academic -feeds
bun run --cwd ui typecheck
```

Expected: focused tests and typecheck pass.

- [ ] **Step 7: Commit UI feature boundaries**

```bash
git add ui/src/api/features.ts ui/src/components/FeatureFlagsProvider.tsx ui/src/components/FeatureGate.tsx ui/src/components/__tests__/FeatureFlagsProvider.test.tsx ui/src/routes ui/src/components/codex
git commit -m "feat: gate optional UI features"
```

---

### Task 6: Feature Documentation, End-to-End Smoke, and Verification Gates

**Files:**
- Modify: `ui/src/docs/content/academic-library-and-reading.mdx`
- Modify: `ui/src/docs/content/books-and-reading.mdx`
- Modify: `ui/src/docs/content/capture-feeds-and-archives.mdx`
- Modify: `README.md` only if its startup configuration example lists optional product surfaces
- Test: existing Rust and UI suites; no source-text-only test

**Interfaces:**
- Consumes: completed backend and UI feature boundaries
- Produces: user instructions that name exact config keys, environment keys, default values, restart requirement, and data-preservation behavior

- [ ] **Step 1: Update feature guides**

Add a short prerequisite to each relevant guide:

```toml
[features]
academic = true
feeds = true
```

Academic and book docs mention `CLEPSYDRA__FEATURES__ACADEMIC`. Feed docs mention `CLEPSYDRA__FEATURES__FEEDS`. State that both default to enabled, changes require restart, and disabling preserves existing Markdown and feed database data. Do not hide these docs when a feature is disabled.

- [ ] **Step 2: Run the actual disabled-feature smoke scenario**

Create a temporary config and vault outside the repository. Start the real server with both flags false. Exercise:

```text
GET /api/features                         -> 200, {"academic":false,"feeds":false}
GET /api/vault/academic/works             -> 404
GET /api/vault/feeds                      -> 404
GET /api/openapi.json                     -> no /api/vault/academic* or /api/vault/feeds* paths
```

Open `/` in Chromium and verify desktop/mobile navigation lacks Academic and Feeds. Open `/academic` and `/feeds` directly and verify the existing not-found surface. Confirm the temporary vault has no `.clepsydra/feeds.db` after shutdown.

- [ ] **Step 3: Run mandatory verification gates**

Run exactly:

```bash
cargo check --all-targets
bun run --cwd ui typecheck
cargo clippy --all-targets -- -D warnings
bun run --cwd ui lint
cargo test --all-targets
bun run --cwd ui test
```

Expected: every command exits zero. Fix source defects rather than suppressing diagnostics or weakening tests.

- [ ] **Step 4: Commit documentation and any gate fixes**

```bash
git add ui/src/docs/content README.md src tests ui/src
git commit -m "docs: document startup feature flags"
```

If `README.md` was unchanged, omit it from `git add`. If verification required code fixes, include only those fixes and their defending tests in this commit.

- [ ] **Step 5: Review the complete branch and integrate**

Run the repository’s code-review workflow against the feature branch merge-base. Resolve all high-confidence Standards and Spec findings. Re-run every verification gate affected by a correction. Commit corrections with a specific `fix:` message, then merge the feature branch into `develop` according to the project feature workflow.
