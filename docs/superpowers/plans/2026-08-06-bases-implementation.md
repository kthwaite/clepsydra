# Bases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate frontmatter to TOML with lossless surgical edits; derive typed, queryable page properties; base files under `bases/` declaring filters, schemas, and views; a filter/sort/group/aggregate query engine; HTTP + LSP surfaces; a table UI with inline editing; the Reading Log as first consumer.

**Architecture:** Pages remain the only source of truth. Frontmatter becomes TOML behind `+++` fences with a dual-read transition (`---` = legacy YAML, quarantined reader) and single-write TOML; `PageMeta.extra` holds `toml::Value` internally with one explicit JSON conversion at the `meta_json` boundary (toml's `Datetime` has a private serde representation — transparent flatten-through-JSON mangles it). A schema-blind `PropertyDeriver` projects extras into a typed EAV table from **native TOML types only**. Bases are vault TOML files parsed into an in-process registry loaded *before* index builds (relation-typed properties join the linkable set, guarded by a derivation epoch). One query evaluator compiles a serde-shared filter AST to SQL behind both the view endpoint and a generic query endpoint. The single new write path — the property patch — is a `toml_edit` splice through `ReplacePageContentCommand`, preserving all untouched bytes. See `docs/superpowers/specs/2026-08-06-bases-design.md`; this plan is execution order only.

**Tech Stack:** Rust 2024, rusqlite (bundled), toml + toml_edit (new deps), serde / serde_json, serde_yaml (legacy reader only, scheduled for removal), Axum 0.8, utoipa, tower-lsp, notify. Frontend: React 19, TanStack Router/Query, react-aria-components, Zustand, Tailwind v4, Vitest.

**Reference docs:** `docs/superpowers/specs/2026-08-06-bases-design.md`, `docs/adr/0001-metadata-projected-folder-layout.md`, `_features/004-codex-reading-log.md`, `docs/configuration.md` (`linkable_properties`).

---

## File Structure

- `src/vault/page.rs` — **modify.** `+++` split, TOML strict/loose parse, canonical TOML serialization, dual-read dispatch, `extra: HashMap<String, toml::Value>`, custom timestamp (de)serialize.
- `src/vault/legacy_yaml.rs` — **new.** The quarantined YAML reader (current parse logic relocated verbatim). Deleted when the doctor census reads zero.
- `src/vault/toml_patch.rs` — **new.** `splice_frontmatter(raw, edits) -> String` on `toml_edit::DocumentMut`; JSON→toml_edit value mapping with type hints.
- `src/vault/toml_json.rs` — **new.** `toml_value_to_json` (date-times → ISO strings) for the `meta_json` boundary.
- `src/vault/derivers/properties.rs` — **new.** `PropertyDeriver` + native-type projection.
- `src/vault/index.rs` — **modify.** `page_properties` DDL + migration; `derivation_meta` table; register deriver; linkable-epoch check; effective-linkable-set composition; `meta_json` write via `toml_value_to_json`.
- `src/vault/base.rs` — **new.** `BaseDefinition`, `PropertyType`, view types, parse + validation, `BaseRegistry`.
- `src/vault/query.rs` — **new.** `Filter` AST, `FieldRef` resolution, SQL compilation, sort/group/aggregate evaluation.
- `src/vault/sync/watcher.rs` — **modify.** Map `bases/*.base.toml` to `ChangeEvent::BaseChanged`.
- `src/vault/config.rs` — **modify.** `bases/**` into default `excluded_patterns`.
- `src/bin/cli.rs` + `src/lib.rs` — **modify.** `clep migrate` subcommand (dry-run default, `--write` to apply); registry load before first build.
- `src/api/bases.rs`, `src/api/query.rs`, `src/api/properties.rs` — **new.** Routes per spec §6.
- `src/api/{mod,openapi,events}.rs` — **modify.** Router + schema registration, `BaseRegistryChanged` SSE.
- `src/lsp/{completion,diagnostics,mod}.rs` — **modify.** `+++` region detection, key/value completion, property diagnostics.
- `src/doctor.rs` — **modify.** Legacy census, base validation, shadowing, type-violation census.
- `ui/src/api/{bases.ts,schema.d.ts}` — new hooks + regenerated types.
- `ui/src/routes/bases.$slug.tsx`, `ui/src/components/bases/` — **new.** `BaseTable`, cell registry, view switcher, group rows.
- `bases/reading.base.toml` (vault, not repo) + `ui/src/components/codex/Atrium.tsx` — **modify.** Pilot wiring.
- `tests/frontmatter_migration.rs`, `tests/bases_api.rs`, `tests/property_patch.rs` — **new.** Integration tests (axum-test, serial_test).

---

## Phase 0 — TOML frontmatter

### Task 0.1: Dual-read + TOML write

**Files:** modify `src/vault/page.rs`; create `src/vault/legacy_yaml.rs`, `src/vault/toml_json.rs`; modify `src/vault/index.rs` (meta_json site), `Cargo.toml`.

- [ ] **Step 1: Failing tests.** `+++` round-trip of the spec §2 example: native date-times land as `toml::Value::Datetime` in `extra`, timestamps as `DateTime<Utc>`; `---` file still parses via legacy path with identical `PageMeta`; first-bytes dispatch (`+++` → TOML, `---` → YAML, neither → whole-file body + fresh meta); strict-then-loose salvage for TOML missing `id`; unparseable TOML → default meta, file untouched, warning (mirror the YAML repair tests); `write_page_content` emits canonical key order with `+++` fences; `toml_value_to_json` turns a local date into `"2026-07-30"` and an offset date-time into RFC 3339 — assert **no** `$__toml_private_datetime` artifact anywhere in `meta_json`; existing `page_revision` tests untouched.
- [ ] **Step 2: Implement.** Relocate current YAML logic to `legacy_yaml.rs` unmodified; TOML strict + loose models; custom serde for `created_at`/`updated_at` as TOML offset date-times; `extra: HashMap<String, toml::Value>`; explicit conversion at the `meta_json` bind site.
- [ ] **Step 3:** Full `cargo test` — every existing vault/index/api test is the regression net for the representation change; expect and fix fallout in anything constructing `PageMeta.extra` literals (board fixtures, academic hooks). `clippy`, `fmt`. Report.

### Task 0.2: Surgical splice

**Files:** create `src/vault/toml_patch.rs`.

- [ ] **Step 1: Failing tests.** Given frontmatter with a comment line and deliberate key order: set one key + remove one + bump `updated_at` → *only those lines differ*, comment and order byte-identical elsewhere (string-diff assertion, not structural); setting a key absent from the doc appends before the closing fence; JSON→toml mapping honors hints (`"2026-08-06"` + `date` hint → native date; unhinted → string; integral JSON number → integer, else float); body untouched byte-for-byte; splice on a `---` page returns a sentinel directing callers to heal-first.
- [ ] **Step 2: Implement** on `toml_edit::DocumentMut`, fence-aware region extraction shared with `page.rs`.
- [ ] **Step 3:** Gates. Report.

### Task 0.3: `clep migrate` + doctor census

**Files:** modify `src/bin/cli.rs`, `src/lib.rs`, `src/doctor.rs`; create `tests/frontmatter_migration.rs`.

- [ ] **Step 1: Failing tests.** Fixture vault with mixed fences: dry run reports would-convert paths and writes nothing; `--write` converts all `---` pages atomically (atomic_file), preserves `id` and every extra, bumps nothing else; second run is a no-op; doctor census counts legacy pages before (n) and after (0); mutation-coordinator test proving heal-on-touch (an `UpdatePageCommand` on a legacy page writes `+++`).
- [ ] **Step 2: Implement.** Subcommand with per-file NO_COLOR-respecting report and a leading "commit your vault first" notice; census section in doctor (read-only, per ADR-0001).
- [ ] **Step 3:** Gates. Report. **Milestone: Phase 0 is shippable alone — merge-worthy before any bases work proceeds.**

---

## Phase 1 — Property derivation

### Task 1.1: Native-type projection

**Files:** create `src/vault/derivers/properties.rs`; register in `derivers/mod.rs`.

- [ ] **Step 1: Failing tests.** Inline `#[cfg(test)]` over `toml::Value` inputs: string → text only (a numeric-looking string gains **no** `value_num` — the anti-sniffing assertion); integer and float → `value_num` + formatted text; boolean → `value_bool`; local date, local date-time, offset date-time → normalized ISO `value_date`; local time → text only; array → rows `ord 0..n`; table → single opaque `value_json` row, null projections; wiki-link string keeps raw text; empty string and empty array → **no rows** (absence = empty; TOML has no null, so this is the sole emptiness rule).
- [ ] **Step 2: Implement** `fn project(value: &toml::Value) -> Vec<Projection>`; `value_json` via `toml_json::toml_value_to_json`.
- [ ] **Step 3:** Gates. Report.

### Task 1.2: Schema + deriver + migration

**Files:** modify `src/vault/index.rs`; extend `properties.rs`.

- [ ] **Step 1: Failing tests.** Index-build tests: page with mixed extras yields expected rows; rebuild after key removal deletes its rows (clear-then-derive idempotence); `ON DELETE CASCADE` on page removal; the three `(key, value_*)` indexes exist; forward migration on a pre-existing index DB succeeds (follow the `links_new` precedent).
- [ ] **Step 2: Implement.** DDL per spec §4 appended to `SCHEMA`; `PropertyDeriver` registered after `TagDeriver`; stale-row clearing in the builder's per-page delete set.
- [ ] **Step 3:** Full `cargo test`. Report.

---

## Phase 2 — Base registry

### Task 2.1: Format, parse, validate

**Files:** create `src/vault/base.rs`; register module.

- [ ] **Step 1: Failing tests.** Parse the spec §3 `reading.base.toml` verbatim; parse the deep-filter array-of-tables form into the identical AST as its inline spelling; slug from filename stem; unknown `type` token → diagnostic, base still listed; property named `title` → rejected-declaration diagnostic; `op = "gt"` against a `select` → diagnostic; duplicate view names → diagnostic; broken TOML → file-level diagnostic, registry unpoisoned.
- [ ] **Step 2: Implement** `BaseDefinition`, `PropertyType` (closed enum: text/number/bool/date/datetime/select/multi_select/url/relation), `ViewDefinition`, `parse_base(path, content) -> (Option<BaseDefinition>, Vec<BaseDiagnostic>)`. System-field reserved list as a `const` shared with Phase 3's resolver.
- [ ] **Step 3:** Gates. Report.

### Task 2.2: Registry + build order + linkable epoch

**Files:** modify `src/vault/base.rs`, `src/vault/index.rs`, `src/lib.rs`, `src/vault/config.rs`.

- [ ] **Step 1: Failing tests.** `BaseRegistry::load(vault_root)` collects all bases; `effective_linkable_properties(config, registry)` = union, deduped; with a base declaring `series = relation`, an *unchanged* page's `series` frontmatter link appears in `links` after the epoch-mismatch rebuild (the skip-unchanged bypass working); epoch stable across no-op rebuilds; `derivation_meta` created by migration.
- [ ] **Step 2: Implement.** `RwLock<BaseRegistry>` in the vault context; registry load precedes the first build; blake3 of the sorted effective set in `derivation_meta`; mismatch → that build ignores content-hash skip. Add `bases/**` to default `excluded_patterns`.
- [ ] **Step 3:** Gates. Report.

### Task 2.3: Watcher + doctor

**Files:** modify `src/vault/sync/watcher.rs`, `src/doctor.rs`, `src/api/events.rs`.

- [ ] **Step 1: Failing tests.** Watcher mapper: `bases/reading.base.toml` upsert → `ChangeEvent::BaseChanged`; `bases/notes.md` → still a page event; `notes/x.toml` → dropped. Doctor: fixture vault with a shadowing `kind` property and one type violation reports both, alongside the Phase-0 legacy census.
- [ ] **Step 2: Implement.** New event arm before the `.md` gate; serve-runtime handler: reload registry → epoch check (possible rebuild) → `BaseRegistryChanged` SSE. Doctor sections read-only.
- [ ] **Step 3:** Gates. Report.

---

## Phase 3 — Query engine

### Task 3.1: AST + field resolution

**Files:** create `src/vault/query.rs`.

- [ ] **Step 1: Failing tests.** Serde round-trips for `All`/`Any`/`Not`/`Cmp` in both TOML (base-file form, inline *and* array-of-tables) and JSON (API form); `FieldRef` resolution: bare `kind` → system, bare `author` → property, `prop.kind` → property, `sys.kind` → system; unknown op token rejected.
- [ ] **Step 2: Implement** per spec §5. `FieldRef::resolve(&BaseDefinition) -> ResolvedField { Sys(SysField) | Prop { key, ty } }`.
- [ ] **Step 3:** Gates. Report.

### Task 3.2: SQL compilation — filters

- [ ] **Step 1: Failing tests.** Against a seeded in-memory index: `eq` on select; `gt` on number uses `value_num` (9 < 10, not "9" > "10"); date range via ISO-string comparison on `value_date`; `contains` on multi_select matches any element; `is_empty` true for both absent key and empty array; `links_to` by canonical and by UUID via `source_field`; `tags` contains; nested `all/any/not`; parameter binding only — assert no value interpolation in generated SQL.
- [ ] **Step 2: Implement** `compile(filter, base_ctx) -> (String, Vec<rusqlite::types::Value>)`, one `EXISTS` per property predicate, column predicates for system fields.
- [ ] **Step 3:** Gates. Report.

### Task 3.3: Sort, group, aggregate, evaluation

- [ ] **Step 1: Failing tests.** Property sort with nulls last; two-key sort (property then system); relation sort by first target canonical; grouped query returns `NULL` bucket labelled empty, `count` + `avg(rating)` correct, rows capped at `group_row_limit` with true per-group totals; flat query honors `PaginationParams`.
- [ ] **Step 2: Implement** `evaluate(conn, base, view_overrides) -> QueryResult { flat rows | groups }`, `LEFT JOIN`-per-sort-key, columns materialized from `ord = 0` projections plus system columns.
- [ ] **Step 3:** Gates. Report.

---

## Phase 4 — HTTP API

### Task 4.1: Read routes

**Files:** create `src/api/bases.rs`, `src/api/query.rs`; modify `src/api/{mod,openapi}.rs`; create `tests/bases_api.rs`.

- [ ] **Step 1: Failing tests** (axum-test): `GET /bases` lists slug + diagnostics count including one broken base; `GET /bases/{slug}` returns the definition; `GET /bases/{slug}/views/{view}` returns evaluated rows honoring view sort; unknown slug/view → 404; `POST /query` with inline `types` map filters numerically.
- [ ] **Step 2: Implement.** utoipa annotations throughout; view endpoint delegates to the Phase 3 evaluator; wire routers.
- [ ] **Step 3:** Gates + `bun run openapi` against a running server; commit regenerated `schema.d.ts`. Report.

### Task 4.2: Property patch

**Files:** create `src/api/properties.rs`; create `tests/property_patch.rs`.

- [ ] **Step 1: Failing tests.** Set two keys + clear one in a single PATCH on a TOML page containing a frontmatter comment → on-disk file differs **only** on the edited lines and `updated_at` (string-diff — the marquee lossless assertion), body byte-identical; hinted date value lands as a native TOML date; response embeds refreshed properties (read-after-write); stale `expected_revision` → 409 with current revision; setting a relation value updates `links` after rebuild; PATCH on a legacy `---` page heals to `+++` then applies; unknown page → 404.
- [ ] **Step 2: Implement.** Read raw → `toml_patch::splice_frontmatter` (with heal-first fallback via full serialization) → `ReplacePageContentCommand { expected content }` → post-mutation index read for the response, per the board pattern. Explicit `set`/`clear` arrays; comment records why the board's tri-state deserializer is not reused.
- [ ] **Step 3:** Full gates + OpenAPI regen. Report.

---

## Phase 5 — LSP (parallel with 6 after 4)

### Task 5.1: Fence context + key completion

**Files:** modify `src/lsp/completion.rs`, `src/lsp/mod.rs`.

- [ ] **Step 1: Failing tests** (existing `test_support` harness): cursor inside `+++` fences at column 0 → keys from bases whose filter matches the page's parsed meta rank first, other bases' keys after, completing to `key = `; cursor in body → untouched wikilink/tag behavior; legacy `---` page → no property items; page matching no base → no property items.
- [ ] **Step 2: Implement** `frontmatter_range(rope) -> Option<Range>` + `property_key_prefix(...)` mirroring the existing prefix-fn style; in-memory filter match against the document's meta (no SQL on the completion path).
- [ ] **Step 3:** Gates. Report.

### Task 5.2: Value completion + diagnostics

**Files:** modify `src/lsp/completion.rs`, `src/lsp/diagnostics.rs`.

- [ ] **Step 1: Failing tests.** After `status = "` → the four select options; after `series = ["[[` prefix → canonical-name items identical to body completion; diagnostics fixture: `rating = "4"` → warning naming the base and expected type (string-where-number); `started = "2026-07-30"` → string-where-date warning; open-vocabulary multi_select novel value → no diagnostic; unresolvable relation target → the existing unresolved-link warning shape.
- [ ] **Step 2: Implement**, reusing the canonical-name completer and link diagnostic machinery; severity warning throughout.
- [ ] **Step 3:** Gates. Report.

---

## Phase 6 — UI table

### Task 6.1: Hooks + route + read-only table

**Files:** create `ui/src/api/bases.ts`, `ui/src/routes/bases.$slug.tsx`, `ui/src/components/bases/BaseTable.tsx` (+ stories).

- [ ] **Step 1: Failing tests** (Vitest): view switcher renders view names from the definition; grouped payload renders group header rows with aggregate chips; title cell links to the page route; SSE `BaseRegistryChanged` + page-change events invalidate the view query.
- [ ] **Step 2: Implement** on react-aria `Table` with sort descriptors mapped to query sort overrides; Vessel tokens only (zero radius, hard shadows, JetBrains Mono grid); Storybook stories for flat + grouped states.
- [ ] **Step 3:** `bun run typecheck`, `lint`, `test`, `knip`. Report.

### Task 6.2: Cell editors

**Files:** create `ui/src/components/bases/cells/` (one file per type, registry-driven like the Slate element descriptors).

- [ ] **Step 1: Failing tests.** Number cell rejects non-numeric commit; select cell offers options; date cell commit sends the ISO value **with a `types` hint**; relation cell offers canonical names (ProjectCombo pattern); commit fires PATCH with only the changed key; 409 → toast (sonner) + refetch, edit preserved in a retry buffer; Escape reverts.
- [ ] **Step 2: Implement** optimistic update reconciled by the embedded read-back row.
- [ ] **Step 3:** Frontend gates. Report.

---

## Phase 7 — Reading Log pilot

### Task 7.1: Base + panel

**Files:** vault `bases/reading.base.toml`; modify `ui/src/components/codex/Atrium.tsx`, `ui/src/components/codex/atrium-data.ts`; update `_features/004-codex-reading-log.md`.

- [ ] **Step 1: Failing tests.** Atrium test: panel renders rows from a mocked `continues` view response; hardcoded Calvino/Borges/Murray entries gone; progress affordance issues a `progress` property PATCH.
- [ ] **Step 2: Implement.** Ship the base file, lift `VITE_ENABLE_PROSPECTIVE_PANELS` for this panel, mark 004 answered-by-reference to the spec.
- [ ] **Step 3:** Full-stack gates, both suites. Dogfood against the real vault: commit, run `clep migrate --write`, seed BOOK pages, edit from both Neovim and the table, watch the SSE loop, and read the git diff of a cell edit — it should touch two lines.
- [ ] **Step 4:** Merge to develop; queue `_features/005` and `006` as fast-follows; open the serde_yaml-removal chore gated on a zero doctor census.
