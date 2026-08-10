# Folio Base Embedding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`. Execute one task per fresh implementation subagent, then run specification-compliance and code-quality reviews before starting the next task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Folio persist, render, configure, and operate a live Base view as a first-class Slate void block, including composed filtering, property editing, and atomic member creation.

**Architecture:** Add one domain-owned composed-query boundary shared by evaluation and member creation; expose a one-snapshot POST evaluation API; then adapt the existing Base table through a Slate-free controller. Register one `base-embed` editor element and one exact Markdown/TOML codec. Slate owns only document configuration and focus; Base mutations continue through existing Base/page APIs.

**Tech Stack:** Rust/Axum/Serde/Utoipa/Rusqlite, React 19, TypeScript, Slate, React Aria Components, TanStack Query, `smol-toml`, Vitest/Testing Library, Storybook, Chromium.

**Approved specification:** `docs/superpowers/specs/2026-08-09-folio-base-embedding-design.md`

## Non-negotiable contracts

- The persisted block is fenced `base` TOML with canonical top-level order `base`, `view`, `filter`, `sort`, `limit` and exactly one terminal LF.
- `sort` has three states: absent inherits the saved view, `[]` removes saved sorting, and non-empty replaces it.
- An absent persisted limit means embedded default `50`; explicit limits are `1..=200`. The POST API itself treats an absent request limit as uncapped.
- Grouped POST output is genuinely uncapped when request `limit` is absent; do not encode this as the existing grouped default of `50`.
- Membership predicate is `Base membership AND saved-view filter AND embed filter`. Saved columns/grouping/aggregates remain authoritative; embed sort replaces saved sort only when present.
- The evaluation response binds `output`, Base `revision`, and `member_creation` to one `StoredBase` load; diagnostics remain inside `output` or the canonical error envelope. Embedded creation uses that response capability, never `BaseDetailResponse.member_creation`.
- `embed_filter` is validated by the same validator and evaluated by the same matcher/compiler as query evaluation. Failed creation leaves neither a page file nor an index row.
- Normal Base embeds never expose source editing. Invalid persisted fences preserve the complete original raw block byte-for-byte and open source-repair mode.
- The renderer contributes exactly one labelled React Aria region, never `role="application"`. Slate owns selection, before/after focus guards, inspector restoration, and removal fallback.
- Standalone Base behavior remains GET-based, preserving its current flat uncapped and grouped default-50 semantics. No Folio-specific branch belongs in `Folio.tsx` or `usePageEditor.ts`.
- Preserve unrelated work. Stage only files named by the active task.

## Execution setup

### Task 0: Create the isolated implementation worktree

**Files:**
- Read: `docs/superpowers/specs/2026-08-09-folio-base-embedding-design.md`
- Create in worktree: `.superpowers/sdd/2026-08-09-folio-base-embedding/progress.md`

- [ ] **Step 1: Create and verify the worktree**

Use `superpowers:using-git-worktrees`. After this plan is committed on `develop`, create `.worktrees/folio-base-embedding` on branch `feature/folio-base-embedding` from that plan commit. Confirm the worktree starts clean and contains both the approved spec and this plan. Keep `d6d48ed` as the approved-spec review baseline.

- [ ] **Step 2: Record the execution ledger**

Create the progress ledger with the plan path, baseline commit, task state, per-task commits, focused test evidence, review findings/fixes, final gates, and browser smoke evidence. Keep it current after every implementation and review commit.

- [ ] **Step 3: Establish the baseline**

Run:

```bash
cargo test
bun run --cwd ui test
```

Record exact baseline results. Do not change production code to repair an unrelated baseline failure; diagnose and report it before continuing.

---

### Task 1: Define and validate composed embed overrides

**Files:**
- Create: `src/vault/base_embed.rs`
- Modify: `src/vault/mod.rs`
- Modify: `src/vault/base.rs`
- Modify: `src/vault/query.rs`
- Test: `src/vault/base_embed.rs`
- Test: `src/vault/base.rs`

**Interfaces:**

```rust
pub struct EmbedOverrides<'a> {
    pub filter: Option<&'a Filter>,
    pub sort: Option<&'a [SortKey]>,
    pub limit: Option<u32>,
}

pub struct EmbedValidationDiagnostic {
    pub field: Option<String>,
    pub filter_path: Option<String>,
    pub message: String,
}

pub fn validate_embed_overrides(
    base: &BaseDefinition,
    overrides: EmbedOverrides<'_>,
) -> Result<(), Vec<EmbedValidationDiagnostic>>;
```

- [ ] **Step 1: Write the failing validation tests**

Add table-driven tests for:

```text
valid typed scalar filter
valid relation links_to filter
nested all/any/not filter paths
system-field allowlist
property declaration resolution
unknown bare field
unknown prop.* field
canonical alias duplicate/reserved-name rejection
unsupported contains on number/bool/system word_count
filter depth 8 and 9
total filter nodes 64 and 65
all/any children 32 and 33
in values 100 and 101
sort keys 8 and 9
field identifier UTF-8 bytes 256 and 257
scalar string UTF-8 bytes 4096 and 4097
limit 1 and 200
limit 0 and 201
```

Assert stable `field`, `filter_path`, and message values. Add a saved-definition regression proving the same invalid non-text `contains` pair is rejected rather than surviving until SQL evaluation.

- [ ] **Step 2: Run RED**

```bash
cargo test vault::base_embed -- --nocapture
cargo test vault::base::tests -- --nocapture
```

Confirm failures are missing validator/definition behavior, not fixture errors.

- [ ] **Step 3: Implement one canonical field/type resolver, complexity guard, and validator**

Move or expose the existing canonical Base resolution rules from `src/vault/query.rs` instead of cloning them. Apply all cheap complexity bounds before recursive validation or SQL compilation, with depth counting the root as 1 and UTF-8 byte—not character—limits. Recursively validate filter shapes and operator/type compatibility. Validate sort fields through the same resolver. Reject duplicate canonical sort keys and canonical aliases that bypass reserved/duplicate rules. Keep `base.rs` independent of Axum and public API envelopes.

- [ ] **Step 4: Run GREEN and refactor**

Run the two focused commands above. Remove any now-obsolete private resolution helper so the repository has one convention.

- [ ] **Step 5: Commit**

```bash
git add src/vault/base_embed.rs src/vault/mod.rs src/vault/base.rs src/vault/query.rs
git commit -m "feat(bases): validate embedded view overrides"
```

---

### Task 2: Compose member capability and candidate matching

**Files:**
- Modify: `src/vault/base_member.rs`
- Modify: `src/vault/base.rs`
- Modify: `src/vault/link.rs` only if canonical relation-target normalization must be shared
- Test: `src/vault/base_member.rs`
- Test: `tests/bases_api.rs`

**Interfaces:**

```rust
pub enum BaseMemberScope {
    Membership,
    View,
    Field,
    Embed,
}

pub struct BaseMemberFieldRequirement {
    // existing fields
    pub membership: bool,
    pub view: bool,
    pub embed: bool,
}

pub fn composed_member_capability(
    base: &BaseDefinition,
    view: &ViewDefinition,
    embed_filter: Option<&Filter>,
) -> BaseMemberCapability;
```

- [ ] **Step 1: Write the failing capability and matcher tests**

Cover simple and nested embed filters, duplicate fields across all three predicates, system/property key shadowing, typed values, canonical/alias/UUID relation targets, mixed-case UUIDs, and unsupported predicates. Assert diagnostics use `scope = "embed"`, preserve the canonical request key in `field`, use an `embed_filter...` root/path in `filter_path`, and carry all three provenance booleans on each requirement.

- [ ] **Step 2: Run RED**

```bash
cargo test vault::base_member -- --nocapture
cargo test --test bases_api capability -- --nocapture
```

- [ ] **Step 3: Extend the existing analyzer and matcher**

Parameterize the existing membership+saved-view capability collector with an optional third predicate. OR provenance flags after canonical field resolution. Route candidate evaluation through the same typed filter matcher and the shared relation canonicalization path; do not add a UI-only or API-only matcher.

Use wrappers with `embed_filter = None` for current standalone callers so semantics remain unchanged without leaving duplicated implementations.

- [ ] **Step 4: Run GREEN**

Run the focused tests. Add a parity assertion for every supported operator/type pair showing candidate matching agrees with query semantics; unsupported pairs must fail validation before matching.

- [ ] **Step 5: Commit**

```bash
git add src/vault/base_member.rs src/vault/base.rs src/vault/link.rs tests/bases_api.rs
git commit -m "feat(bases): compose embedded member capabilities"
```

---

### Task 3: Represent uncapped grouped evaluation explicitly

**Files:**
- Modify: `src/vault/query.rs`
- Modify: `src/api/query.rs`
- Modify: `src/api/bases.rs`
- Modify: `src/vault/base_embed.rs`
- Test: `src/vault/query.rs`
- Test: `tests/bases_api.rs`

**Interfaces:**

```rust
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum GroupRowLimit {
    #[default]
    Default,
    Unlimited,
    Limit(u32),
}

pub struct QuerySpec {
    // existing fields
    pub group_row_limit: GroupRowLimit,
}
```

`Default` preserves the existing generic-query/saved-view default of 50; `Unlimited` is used only for an uncapped embedded POST; `Limit(n)` is explicit.

- [ ] **Step 1: Write failing query-limit tests**

Use more than 50 rows in one group and assert:

```text
GroupRowLimit::Default -> 50 returned, true total retained
GroupRowLimit::Unlimited -> every row returned
GroupRowLimit::Limit(1) -> one returned, true total/aggregates retained
flat limit None -> uncapped
flat limit Some(1) -> one returned
```

Add API/query mapping tests proving generic `group_row_limit: None` remains `Default`.

- [ ] **Step 2: Run RED**

```bash
cargo test vault::query::tests -- --nocapture
cargo test --test bases_api grouped -- --nocapture
```

- [ ] **Step 3: Implement the tri-state without sentinels**

Replace implicit `Option<u32>` grouped semantics with `GroupRowLimit`. Update every `QuerySpec` constructor. In `base_embed.rs`, add the composed query builder:

```rust
pub fn composed_query_spec(
    base: &BaseDefinition,
    view: &ViewDefinition,
    filter: Option<Filter>,
    sort: Option<Vec<SortKey>>,
    limit: Option<u32>,
) -> QuerySpec;
```

Compose `base.file.filter AND view.filter AND filter`, retain saved columns/grouping/aggregates, use replacement sort only when `Some`, and map absent embedded limit to flat `None` plus grouped `Unlimited`.

- [ ] **Step 4: Run GREEN and all query tests**

```bash
cargo test vault::query -- --nocapture
cargo test --test bases_api
```

- [ ] **Step 5: Commit**

```bash
git add src/vault/query.rs src/vault/base_embed.rs src/api/query.rs src/api/bases.rs tests/bases_api.rs
git commit -m "feat(bases): support uncapped embedded group queries"
```

---

### Task 4: Add one-snapshot composed evaluation API

**Files:**
- Modify: `src/api/bases.rs`
- Modify: `src/api/error.rs`
- Modify: `src/api/openapi.rs`
- Modify: `src/api/mod.rs` only if route registration requires it
- Test: `tests/bases_api.rs`
- Test: `tests/openapi_contract.rs`

**Wire contract:**

```rust
pub struct BaseViewEvaluateRequest {
    pub filter: Option<Filter>,
    pub sort: Option<Vec<SortKey>>,
    pub limit: Option<u32>,
}

pub struct BaseViewEvaluateResponse {
    pub output: QueryOutput,
    pub revision: String,
    pub member_creation: BaseMemberCapability,
}
```

Route: `POST /api/vault/bases/{slug}/views/{view}/evaluate`.

- [ ] **Step 1: Write failing route tests**

Add integration tests for flat/grouped composition, saved sort inheritance, empty-sort reset, replacement ordering, limit `1`/`200`, `0`/`201`, unknown/duplicate/canonical-alias fields, typed scalar/relation/logical filters, and exact response shape. Add missing Base/view, stale files, and sanitized internal I/O failure cases.

Add a deterministic seam or instrumented loader test proving the handler calls `base_document::load` exactly once and that output/revision/capability come from that snapshot.

- [ ] **Step 2: Write failing body/error tests**

Assert a valid request body of exactly 64 KiB is accepted. Assert malformed JSON and a body of 64 KiB plus one return the canonical HTTP 400 envelope:

```json
{
  "status": 400,
  "error": "invalid embed query",
  "detail": {
    "code": "invalid_embed_query",
    "diagnostics": []
  }
}
```

The route must retain the existing `ApiError.status` field and must not leak Axum's extractor text or an internal `500` detail.

- [ ] **Step 3: Run RED**

```bash
cargo test --test bases_api evaluate_embedded -- --nocapture
cargo test --test openapi_contract -- --nocapture
```

- [ ] **Step 4: Implement the route and bounded extractor**
Load one `StoredBase`, resolve the saved view from that value, validate overrides, build the composed `QuerySpec`, evaluate it, and derive capability from the same loaded definition. Map `EmbedValidationDiagnostic` into the public `BaseMemberDiagnostic` shape with `BaseMemberScope::Embed`, canonical request keys, and `embed_filter...` paths. ASCII-fold only the view lookup identity; preserve configured strings.

Use a route-local 64-KiB `DefaultBodyLimit` plus a fallible `Bytes` extraction and explicit `serde_json::from_slice` mapping so all malformed/oversized payloads use the public envelope. Do not globally change JSON limits.

- [ ] **Step 5: Register exact OpenAPI components and operation**

Register request/response DTOs, recursive filter/sort references, the POST operation, and `embed` enum/provenance additions. Update operation-count assertions deliberately.

- [ ] **Step 6: Run GREEN**

```bash
cargo test --test bases_api
cargo test --test openapi_contract
```

- [ ] **Step 7: Commit**

```bash
git add src/api/bases.rs src/api/error.rs src/api/openapi.rs src/api/mod.rs tests/bases_api.rs tests/openapi_contract.rs
git commit -m "feat(api): evaluate embedded Base views"
```

---

### Task 5: Make filtered member creation atomic

**Files:**
- Modify: `src/api/base_members.rs`
- Modify: `src/vault/base_member.rs`
- Modify: `src/vault/mutation_coordinator.rs` only if the existing transaction input must carry the third predicate
- Modify: `src/vault/index.rs` only to preserve the existing transaction/savepoint contract
- Test: `tests/bases_api.rs`
- Test: `tests/api_test.rs`
- Test: `tests/index_test.rs` only for transaction-driver signature fallout

**Wire delta:**

```rust
pub struct BaseMemberCreateRequest {
    // existing fields
    pub embed_filter: Option<Filter>,
}
```

- [ ] **Step 1: Write failing atomicity tests**

Cover successful Base+view+embed creation; mismatch; invalid embed fields/operators; serialized `embed_filter` at exactly 64 KiB and 64 KiB plus one; stale revision; pre-publication cancellation; cancellation after publication; injected failure before publication, after file publication, and during index mutation. Widen the existing private deterministic creation seam to accept a fixed page UUID in tests while production still uses `PageMeta::new`. For every rejection, pre-boundary cancellation, and failure, assert both the expected page path and that exact index UUID are absent. For cancellation after publication, preserve the current contract: the atomic operation completes, the file and index row both exist, and exactly one notification is emitted—never a partial state.

- [ ] **Step 2: Run RED**

```bash
cargo test --test bases_api filtered_member -- --nocapture
cargo test --test api_test page_create -- --nocapture
cargo test --test index_test transaction -- --nocapture
```

- [ ] **Step 3: Validate and match through shared domain code**

Reject oversized filters before mutation. Validate `embed_filter` with `validate_embed_overrides`. Map every invalid override—including complexity, field, operator, and size failures—to the same HTTP 400 `invalid embed query` envelope used by evaluation, with `status: 400`, `scope: "embed"`, canonical request keys in `field`, and `embed_filter...` in `filter_path`; do not route these through the existing generic 422 member-validation helper. Recompute the composed capability from the same revision used by submission, coerce native TOML values once, and verify the completed candidate against all three predicates before calling the mutation coordinator.

Do not create then compensate-delete. Retain the current same-transaction file/index publication, rollback error source chain, phase-specific cancellation behavior, notifier behavior, and sanitized public error mapping.

- [ ] **Step 4: Run GREEN and regression suites**

Run the three focused commands, then:

```bash
cargo test --test bases_api
cargo test --test api_test
```

- [ ] **Step 5: Commit**

```bash
git add src/api/base_members.rs src/vault/base_member.rs src/vault/mutation_coordinator.rs src/vault/index.rs tests/bases_api.rs tests/api_test.rs tests/index_test.rs
git commit -m "feat(bases): create filtered embedded members atomically"
```

---

### Task 6: Generate frontend contracts and add query identities

**Files:**
- Modify generated: `ui/src/api/schema.d.ts`
- Modify: `ui/src/api/bases.ts`
- Modify: `ui/src/api/keys.ts` if the normalized POST key belongs in the central factory
- Create: `ui/src/components/bases/embed-query.ts`
- Modify: `ui/src/components/bases/member-draft.ts`
- Modify: `ui/src/components/bases/BaseMemberDraft.tsx`
- Test: `ui/src/api/bases.test.ts`
- Create test: `ui/src/components/bases/__tests__/embed-query.test.ts`
- Modify tests: `ui/src/components/bases/__tests__/member-draft.test.ts`, `BaseMemberDraft.test.tsx`

- [ ] **Step 1: Regenerate the OpenAPI client**

Start the server from the feature worktree with the existing development config and wait for port 3000 readiness; then run:

```bash
bun run --cwd ui openapi
```

Stop the server. Inspect generated types; never hand-edit `schema.d.ts`.

- [ ] **Step 2: Write failing identity and API tests**

Assert recursive object keys sort while logical children and sort arrays retain order; ASCII-fold view identity; absent sort differs from `[]`; absent persisted limit normalizes to `50`; request payload still omits absent sort; POST key includes normalized slug/view/filter/sort/limit; A/B identities cannot share results.

Add generated runtime fixtures for `scope: "embed"` and `embed: true/false`. Assert property and member mutations invalidate Base evaluations and affected page caches while preserving unrelated query scopes.

- [ ] **Step 3: Run RED**

```bash
bun run --cwd ui test src/api/bases.test.ts src/components/bases/__tests__/embed-query.test.ts src/components/bases/__tests__/member-draft.test.ts src/components/bases/__tests__/BaseMemberDraft.test.tsx
```

- [ ] **Step 4: Implement pure identities and the POST query hook**

Export:

```ts
export interface BaseEmbedConfig {
  base: string;
  view: string;
  filter?: BaseFilter;
  sort?: SortKey[];
  limit?: number;
}

export const EMBED_DEFAULT_LIMIT = 50;
export function normalizeEmbedConfiguration(config: BaseEmbedConfig): NormalizedEmbedConfig;
export function predicateIdentity(config: BaseEmbedConfig): string;
export function capabilityIdentity(config: BaseEmbedConfig, revision: string): string;
export function queryIdentity(config: BaseEmbedConfig): string;
```

Define `BaseEmbedConfig` in this pure module so query/controller tasks do not depend on the later Slate element union; Task 9's configured node reuses this shape. Use explicit normalized markers so inherited sort is not conflated with empty sort. Add a typed `useBaseViewEvaluation`/options layer around generated `fetchClient.POST`. Keep `useBaseView` for standalone GET.

Converge mutation invalidation through one helper. Add Embed provenance to draft-field deduplication and accessible requirement text; do not fork the draft model.

- [ ] **Step 5: Run GREEN**

Run the focused command above and UI typecheck.

- [ ] **Step 6: Commit**

```bash
git add ui/src/api/schema.d.ts ui/src/api/bases.ts ui/src/api/keys.ts ui/src/components/bases/embed-query.ts ui/src/components/bases/member-draft.ts ui/src/components/bases/BaseMemberDraft.tsx ui/src/api/bases.test.ts ui/src/components/bases/__tests__/embed-query.test.ts ui/src/components/bases/__tests__/member-draft.test.ts ui/src/components/bases/__tests__/BaseMemberDraft.test.tsx
git commit -m "feat(ui): query embedded Base views"
```

---

### Task 7: Extract the shared Base table controller

**Files:**
- Create: `ui/src/components/bases/useBaseTableController.ts`
- Modify: `ui/src/components/bases/BaseTable.tsx`
- Modify: `ui/src/components/bases/BaseTableView.tsx`
- Modify: `ui/src/components/bases/BaseTable.stories.tsx`
- Modify tests: `ui/src/components/bases/__tests__/BaseTable.test.tsx`, `BaseTableView.test.tsx`
- Create test: `ui/src/components/bases/__tests__/useBaseTableController.test.tsx`

**Controller input:**

```ts
export interface BaseTableControllerOptions {
  mode: "standalone" | "embedded";
  slug: string;
  activeView: string;
  sort: SortKey[] | undefined;
  filter?: BaseFilter;
  limit?: number;
  onViewChange(view: string): void;
  onSortChange(sort: SortKey[] | undefined): void;
}
```

- [ ] **Step 1: Freeze current standalone behavior in tests**

Before extraction, assert standalone uses GET, is uncapped, translates only the first sort key to `{sort,dir}`, uses detail-provided capability, preserves all existing creation/revision/refetch/focus/notice behavior, and never sends `embed_filter`.

- [ ] **Step 2: Write failing embedded controller tests**

Cover POST request/body/key, including `limit: 50` when the persisted node omits `limit`; response-owned revision and capability; exact A→B and B→A stale-result suppression; predicate vs query identity invalidation; stale same-predicate revision retaining draft values while disabling Save; changed predicate obsoleting work; `embed_filter` create payload; capped success focusing only when present and otherwise announcing exclusion; removal/unmount cancellation.

- [ ] **Step 3: Run RED**

```bash
bun run --cwd ui test src/components/bases/__tests__/BaseTable.test.tsx src/components/bases/__tests__/useBaseTableController.test.tsx
```

- [ ] **Step 4: Extract orchestration without Slate imports**

Move query selection, property commits, member draft/diagnostics, tokens, revision-conflict refresh, authoritative presence/focus reconciliation, and notices from `BaseTable` into the controller. `BaseTable` becomes a small standalone local view/sort wrapper. Embedded mode uses only POST `revision/member_creation`; Base detail remains presentation/schema data.
Normalize an absent embedded `limit` to `EMBED_DEFAULT_LIMIT` before constructing both the POST body and query identity. The API's absent-limit uncapped behavior remains available to non-Folio callers but is not the Folio default.

Keep cached successful output only for the exact normalized query key. A same-key loading/error state remains adjacent; a different key with no success renders no stale rows.

- [ ] **Step 5: Run GREEN and typecheck**

Run focused tests and:

```bash
bun run --cwd ui typecheck
```

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/bases/useBaseTableController.ts ui/src/components/bases/BaseTable.tsx ui/src/components/bases/BaseTableView.tsx ui/src/components/bases/BaseTable.stories.tsx ui/src/components/bases/__tests__/BaseTable.test.tsx ui/src/components/bases/__tests__/BaseTableView.test.tsx ui/src/components/bases/__tests__/useBaseTableController.test.tsx
git commit -m "refactor(ui): share Base table orchestration"
```

---

### Task 8: Adapt table sorting, cache presentation, and entry focus

**Files:**
- Modify: `ui/src/components/bases/BaseTableView.tsx`
- Modify: `ui/src/components/bases/BaseTable.tsx`
- Modify: `ui/src/components/bases/useBaseTableController.ts`
- Modify: `ui/src/components/bases/BaseTable.stories.tsx`
- Test: `ui/src/components/bases/__tests__/BaseTableView.test.tsx`
- Test: `ui/src/components/bases/__tests__/BaseTable.test.tsx`

**Presentation interfaces:**

```ts
export interface BaseTableViewHandle {
  focusEntry(): boolean;
}

export interface BaseTableViewProps {
  // existing presentation props
  sort: SortKey[] | undefined;
  onSortChange(sort: SortKey[] | undefined): void;
}
```

- [ ] **Step 1: Write failing presentation/focus tests**

Assert React Aria displays only `sort?.[0]`; a sortable header emits exactly one replacement key; view changes reset to inherited sort; cached rows remain mounted beside same-key loading/error; flat and grouped caps report exclusion while true totals/aggregates remain visible; `focusEntry()` selects active-view/table control and returns `false` when no valid target exists.

Retain existing delayed created-title focus tests and add disappearance, view switch, same-ID reappearance, no-title, loading/error, and created-focus-priority cases.

- [ ] **Step 2: Run RED**

```bash
bun run --cwd ui test src/components/bases/__tests__/BaseTableView.test.tsx src/components/bases/__tests__/BaseTable.test.tsx
```

- [ ] **Step 3: Implement the presentation-only contract**

Use `forwardRef`/`useImperativeHandle` for the entry handle. Preserve one labelled region and the existing React Aria table. Keep the token+node+view+row connectivity checks and timer/microtask reconciliation; render must remain pure with no ref/state mutation during render.

Do not add Slate imports. Do not alter cell editor commit/focus behavior.

- [ ] **Step 4: Run GREEN, typecheck, and focused accessibility tests**

Run the focused command and typecheck.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/bases/BaseTableView.tsx ui/src/components/bases/BaseTable.tsx ui/src/components/bases/useBaseTableController.ts ui/src/components/bases/BaseTable.stories.tsx ui/src/components/bases/__tests__/BaseTableView.test.tsx ui/src/components/bases/__tests__/BaseTable.test.tsx
git commit -m "feat(ui): adapt Base tables for embedding"
```

---

### Task 9: Implement the Base embed schema and exact Markdown codec

**Files:**
- Modify: `ui/package.json`
- Modify: `ui/bun.lock`
- Modify: `ui/src/editor/schema/types.ts`
- Modify: `ui/src/editor/schema/registry.ts`
- Modify: `ui/src/editor/schema/documentRules.ts`
- Create: `ui/src/editor/schema/elements/baseEmbed.tsx`
- Create: `ui/src/editor/convert/baseEmbedMarkdown.ts`
- Modify: `ui/src/editor/convert/mdastTypes.ts`
- Modify: `ui/src/editor/convert/mdast-to-slate.ts`
- Modify: `ui/src/editor/convert/slate-to-mdast.ts`
- Modify tests: `ui/src/editor/schema/__tests__/classification.test.ts`, `documentRules.test.ts`, `normalize.test.ts`
- Create test: `ui/src/editor/convert/__tests__/baseEmbedMarkdown.test.ts`
- Modify tests: `ui/src/editor/convert/__tests__/mdast-to-slate.test.ts`, `slate-to-mdast.test.ts`, `round-trip.test.ts`

- [ ] **Step 1: Add the direct parser dependency**

```bash
bun add --cwd ui smol-toml@1.7.1
```

Use only `parse` for data-only decoding. Do not use generic `stringify` for persisted output because it does not guarantee the approved inline-table/key-order contract.

- [ ] **Step 2: Write failing schema tests**

Add the exact union:

```ts
type BaseEmbedElement =
  | { type: "base-embed"; status: "unconfigured"; children: [{ text: "" }] }
  | { type: "base-embed"; status: "configured"; base: string; view: string; filter?: BaseFilter; sort?: SortKey[]; limit?: number; children: [{ text: "" }] }
  | { type: "base-embed"; status: "invalid"; rawBlock: string; parseError: string; children: [{ text: "" }] };
```

Assert descriptor kind `void-block`, factory output, child repair, every valid status, and terminal-embed trailing paragraph normalization. For malformed/unknown status, malformed configured fields, stale configured-only properties on unconfigured nodes, and stale invalid-only properties on configured nodes, assert normalization produces the exact invalid recovery node without guessing or retaining mixed status state.

- [ ] **Step 3: Write failing codec tests**

Table-drive exact raw preservation for comments, whitespace, CRLF, final/no-final newline, 4+ delimiters/internal backticks, unclosed fences, unknown top-level/nested keys, and empty body. Exercise CRLF, present/absent final LF, and an invalid raw block between ordinary paragraphs through the public `slateToMarkdown` entry point—not only the custom mdast handler. Check 64-KiB UTF-8 body and plus one with `TextEncoder`, not JS string length. Assert exact `base` recognition (`meta == null`); `base extra` and unknown languages remain ordinary code.
Assert `base` and `view` are required and nonblank while valid non-whitespace contents are preserved without trimming. Assert configured canonical output for nested filters, arrays/tables, escaping, absent vs empty sort, and limits. At both the accepted boundary and boundary plus one, test depth 8, total nodes 64, all/any children 32, `in` values 100, sort keys 8, field identifiers 256 UTF-8 bytes, scalar strings 4096 UTF-8 bytes, and limit 200. Assert emergency unconfigured serialization is a real empty recovery fence and reloads as one invalid node.

- [ ] **Step 4: Run RED**

```bash
bun run --cwd ui test src/editor/schema/__tests__ src/editor/convert/__tests__/baseEmbedMarkdown.test.ts src/editor/convert/__tests__/mdast-to-slate.test.ts src/editor/convert/__tests__/slate-to-mdast.test.ts src/editor/convert/__tests__/round-trip.test.ts
```

- [ ] **Step 5: Implement one descriptor and source-aware conversion branch**

Thread original Markdown source through `convertChildren`/`convertBlockNode`. Slice the complete fence via mdast offsets; include an immediate LF/CRLF after a closed fence and preserve unclosed end-of-source exactly. Parse with `smol-toml`, then recursively validate closed object shapes, operators, value presence, sort directions, limit range, and every approved complexity/UTF-8-byte bound before constructing a configured node.

Add one custom mdast raw-block node/handler. Configured output uses a dedicated deterministic serializer; invalid output returns `rawBlock` verbatim. Register only through the existing descriptor registry; do not add a renderer switch.

- [ ] **Step 6: Run GREEN and round-trip suite**

Run the focused command and typecheck.

- [ ] **Step 7: Commit**

```bash
git add ui/package.json ui/bun.lock ui/src/editor/schema/types.ts ui/src/editor/schema/registry.ts ui/src/editor/schema/documentRules.ts ui/src/editor/schema/elements/baseEmbed.tsx ui/src/editor/convert/baseEmbedMarkdown.ts ui/src/editor/convert/mdastTypes.ts ui/src/editor/convert/mdast-to-slate.ts ui/src/editor/convert/slate-to-mdast.ts ui/src/editor/schema/__tests__ ui/src/editor/convert/__tests__
git commit -m "feat(editor): persist Base embed blocks"
```

---

### Task 10: Build the structured/source-repair inspector

**Files:**
- Create: `ui/src/components/bases/OrderedSortEditor.tsx`
- Modify: `ui/src/components/bases/ViewDefinitionEditor.tsx`
- Modify: `ui/src/components/bases/MembershipEditor.tsx`
- Modify: `ui/src/components/bases/FilterGroupEditor.tsx` only if diagnostic-root plumbing requires it
- Modify: `ui/src/components/bases/FilterComparisonEditor.tsx` only if diagnostic-root plumbing requires it
- Create: `ui/src/components/bases/BaseEmbedInspector.tsx`
- Create test: `ui/src/components/bases/__tests__/BaseEmbedInspector.test.tsx`
- Modify test: `ui/src/components/bases/__tests__/ViewsEditor.test.tsx`

- [ ] **Step 1: Extract ordered sort behavior under existing tests**

Move the existing `ViewDefinitionEditor` sort UI into `OrderedSortEditor` without changing behavior: scalar-sortable field vocabulary, add/remove/reorder, and asc/desc. Keep current view-editor tests green before using it in the inspector.

- [ ] **Step 2: Write failing inspector tests**

Assert labelled Base and saved-view selectors, base change selecting first view and clearing filter/sort while retaining limit, view change clearing sort only, one whole-node Save callback, configured Cancel with no write, invalid source-repair Cancel with no write, valid source-repair Save, missing Base/view recoverability, initial focus, Escape, and no stale selector/diagnostic results after rapid changes. Before Save, assert selected-Base declared/canonical field validation and every shared complexity/UTF-8 bound at N and N+1; each invalid state shows field-level diagnostics and disables Save. Source-repair cases must assert that the textarea receives the extracted TOML body—not fence delimiters—for 4+ backtick fences, CRLF, and unclosed input, and that Save replaces the whole Slate node.
- [ ] **Step 3: Run RED**

```bash
bun run --cwd ui test src/components/bases/__tests__/ViewsEditor.test.tsx src/components/bases/__tests__/BaseEmbedInspector.test.tsx
```

- [ ] **Step 4: Implement the inspector with existing primitives**

Use `useBases()` for registry summaries, `useBase(slug)` for selected detail, native labelled selects following current Base editor conventions, the parameterized `MembershipEditor` label `Embed filter`, shared `OrderedSortEditor`, numeric `1..200` control, and existing React Aria `Dialog` shell. Validate the local structured draft with the same pure codec/domain-shape validator used for persisted source plus the selected Base's declared field vocabulary; the visual builder itself must not be treated as a complexity guard.

For invalid nodes, show source repair only; parse/validate through `baseEmbedMarkdown.ts`. Keep every edit local until Save. Expose one `onSave(nextNode)` and `onCancel()` contract; the inspector never calls Slate transforms itself.

- [ ] **Step 5: Run GREEN and typecheck**

Run focused tests and typecheck.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/bases/OrderedSortEditor.tsx ui/src/components/bases/ViewDefinitionEditor.tsx ui/src/components/bases/MembershipEditor.tsx ui/src/components/bases/FilterGroupEditor.tsx ui/src/components/bases/FilterComparisonEditor.tsx ui/src/components/bases/BaseEmbedInspector.tsx ui/src/components/bases/__tests__/BaseEmbedInspector.test.tsx ui/src/components/bases/__tests__/ViewsEditor.test.tsx
git commit -m "feat(ui): configure Folio Base embeds"
```

---

### Task 11: Wire Slate insertion, rendering, focus, and live table behavior

**Files:**
- Create: `ui/src/editor/baseEmbedEditing.tsx`
- Create: `ui/src/editor/elements/BaseEmbedElement.tsx`
- Create: `ui/src/editor/elements/EmbeddedBaseTable.tsx`
- Modify: `ui/src/editor/schema/elements/baseEmbed.tsx`
- Modify: `ui/src/editor/SlateEditor.tsx`
- Modify test: `ui/src/editor/__tests__/slashCommandToConversion.test.ts`
- Create test: `ui/src/editor/__tests__/SlateEditor.base-embed.test.tsx`
- Create test: `ui/src/editor/elements/BaseEmbedElement.test.tsx`
- Modify: `ui/src/editor/schema/elements.stories.tsx` or create one mocked Base-embed story

- [ ] **Step 1: Write failing command/session tests**

Using the real `SlateEditor` harness, cover slash command discovery; insertion of exactly one selected unconfigured void; inspector opening; Save replacing that identity once; Cancel removing that exact node and restoring the pre-insertion bookmark; emergency save/reload; configured/invalid edit restoration; and node removal while the inspector is open.

The Base command must be special handling in `executeSlashCommand`, not a generic paragraph `BlockConversion`.

- [ ] **Step 2: Write failing keyboard ownership tests**

Cover selected-void Enter/F2 target order (active table/view control, Edit, Remove), before-guard Shift+Tab including first-block after-point fallback, after-guard Tab, unhandled Escape exit, descendant-prevented Escape, deletion only when `ReactEditor.isFocused(editor)`, following/preceding removal fallback, inspector restoration, and no selection/focus loss after autosave/re-render.

- [ ] **Step 3: Write failing live-table adapter tests**

With a mocked controller, assert view changes preserve filter/limit and remove sort, header sort replaces all keys, property commits never transform the Slate node, title/configure navigation works, the adapter passes the node's exact embed filter into the controller, missing Base/view and query error/loading/cached states remain recoverable, and unmount obsoletes pending work. The actual `embed_filter` wire payload remains covered by Task 7's controller/API test.

- [ ] **Step 4: Run RED**

```bash
bun run --cwd ui test src/editor/__tests__/slashCommandToConversion.test.ts src/editor/__tests__/SlateEditor.base-embed.test.tsx src/editor/elements/BaseEmbedElement.test.tsx
```

- [ ] **Step 5: Implement the editing session and renderer**

Follow `mathEditing.tsx` for provider shape but use a `PathRef`, original node identity, insertion bookmark/range ref, and registered entry-focus handle. The renderer must spread Slate attributes on its top-level element, include `children`, and put interactive descendants under `contentEditable={false}`.

`EmbeddedBaseTable` is the only Slate adapter: it calls the shared controller and owns the one-node `Transforms.setNodes` for view and sort changes. `BaseEmbedElement` owns selection chrome, wrapper focus guards, Edit/Remove controls, inspector, deterministic fallback, and lifecycle cleanup. `BaseTableView` remains the sole owner of the labelled table region. Every outer Escape handler first checks `event.defaultPrevented`.
Do not add another `role="application"`, renderer switch, or Folio-specific persistence path.

- [ ] **Step 6: Run GREEN, all editor/Base focused tests, and typecheck**

```bash
bun run --cwd ui test src/editor src/components/bases
bun run --cwd ui typecheck
```

- [ ] **Step 7: Commit**

```bash
git add ui/src/editor/baseEmbedEditing.tsx ui/src/editor/elements/BaseEmbedElement.tsx ui/src/editor/elements/EmbeddedBaseTable.tsx ui/src/editor/schema/elements/baseEmbed.tsx ui/src/editor/SlateEditor.tsx ui/src/editor/__tests__/slashCommandToConversion.test.ts ui/src/editor/__tests__/SlateEditor.base-embed.test.tsx ui/src/editor/elements/BaseEmbedElement.test.tsx ui/src/editor/schema/elements.stories.tsx
git commit -m "feat(editor): operate Base views inside Folios"
```

---

### Task 12: Document, smoke-test, and finish the feature branch

**Files:**
- Modify: `docs/superpowers/specs/2026-08-09-folio-base-embedding-design.md` only if implementation exposed a corrected factual contract; never weaken acceptance criteria
- Modify: `ui/src/docs/content/bases.mdx`
- Add focused regression tests only when the smoke scenario exposes a real bug

- [ ] **Step 1: Write the user guide**

Document Bases as non-owning page views, how to insert **Base embed**, the structured inspector, persisted fenced syntax, default/maximum limits, sort inheritance/reset, property editing, Add-member visibility/cap behavior, missing/invalid recovery, and keyboard entry/exit/remove behavior. Use one valid example:

````markdown
```base
base = "reading-log"
view = "Currently reading"
filter = { field = "rating", op = "gte", value = 4 }
sort = [{ field = "rating", dir = "desc" }]
limit = 20
```
````

State that normal configured embeds are not edited as raw source.

- [ ] **Step 2: Run focused end-to-end API verification**

Create a temporary vault containing a Base, saved view, typed properties, grouped output, and enough rows to exercise caps. Exercise the POST evaluation and filtered member endpoints directly. Record request/response evidence for composition, one-snapshot revision/capability, uncapped grouped output, cap behavior, successful creation, mismatch rollback, and invalid-request envelope.

- [ ] **Step 3: Run the browser smoke scenario**

Use `superpowers:playwright` with an isolated server and temporary vault. In Chromium:

```text
open Folio -> insert Base embed -> inspector opens
select Base/view -> add nested filter, ordered sort, limit -> Save
verify live table, title navigation, view switch/reset, and header sort persistence
edit typed property -> reload -> persisted
Add member -> fill view+membership+embed fields -> save -> row visible or cap notice
exercise Enter/F2, Tab, Shift+Tab, Escape, Delete/Backspace and inspector focus restoration
edit another paragraph -> reload -> configured fence survives canonically
load malformed/missing Base/view fences -> recover without data loss
```

Inspect console and network failures. Save exact screenshot/log paths in the ledger. Remove temporary vault/config/service artifacts after proof.

- [ ] **Step 4: Run mandatory verification gates**

```bash
cargo fmt --check
cargo check --all-targets
cargo clippy --all-targets -- -D warnings
cargo test
bun run --cwd ui typecheck
bun run --cwd ui lint
bun run --cwd ui test
bun run --cwd ui build
```

All must pass. Record exact counts/results; do not summarize a partial suite as full verification.

- [ ] **Step 5: Review the whole branch**

Package the complete branch diff from `d6d48ed` to HEAD and dispatch a fresh whole-branch reviewer. Fix every Critical/Important issue with focused regression tests, re-review each fix, and repeat until the reviewer returns ready to merge. Re-run affected gates after each fix and all gates after the final fix.

- [ ] **Step 6: Commit documentation**

Keep the ignored execution ledger as local evidence; do not force-add it.
```bash
git add ui/src/docs/content/bases.mdx docs/superpowers/specs/2026-08-09-folio-base-embedding-design.md
git commit -m "docs(bases): explain Folio embeds"
```

- [ ] **Step 7: Merge into `develop` safely**

Use `superpowers:finishing-a-development-branch`. Immediately before integration, inspect the live main-worktree status and classify every path not owned by this feature. Do not overwrite, stash, stage, commit, or otherwise alter any then-current unrelated change without explicit user approval. Resolve only genuine feature conflicts, preserve both sides' intent, rerun every verification gate on the integrated tree, then commit the merge and remove the feature worktree/branch only after proof.

## Final acceptance checklist

- [ ] Composed evaluation and atomic creation use one domain contract and stable public diagnostics.
- [ ] One-snapshot response binds output, revision, and capability.
- [ ] Grouped absent-limit POST evaluation is truly uncapped; embedded UI default remains 50.
- [ ] Generated OpenAPI types are current; no handwritten schema drift exists.
- [ ] Standalone Base GET behavior and existing cell/member interactions are unchanged.
- [ ] Base embed Markdown is deterministic when valid and byte-exact when invalid.
- [ ] Slate selection, focus, inspector, removal, and race contracts pass rendered tests and Chromium smoke.
- [ ] Property edits and member creation mutate pages only; view/sort configuration mutates one Folio node only.
- [ ] Missing references, malformed source, stale revisions, cap exclusion, and same-key cached errors are recoverable.
- [ ] Rust format/check/clippy/tests, UI typecheck/lint/tests/build, whole-branch review, and integrated-tree gates all pass.
