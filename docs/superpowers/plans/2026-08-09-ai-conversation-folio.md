# AI Conversation Folio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `AI_CONVERSATION` Folio kind that ChatGPT or Claude can create and safely append through a structured Clepsydra MCP tool while preserving participant turns in portable Markdown and a Folio-native Read/Edit presentation.

**Architecture:** A new vault-domain module owns conversation hashing, append ledgers, and canonical Markdown emission. A dedicated Axum capture endpoint performs exact identity lookup and atomic create/append through `MutationCoordinator`; MCP remains a thin HTTP adapter. The frontend recognizes canonical turn callouts as Slate elements, renders an editorial transcript in Read mode, and exposes structured editing in Edit mode.

**Tech Stack:** Rust 2024, Axum, rusqlite/SQLite JSON1, serde/TOML, sha2, rmcp, utoipa/OpenAPI, React 19, TypeScript, Slate, TanStack Query, Vitest/Testing Library, Biome.

## Global Constraints

- Capture only visible `user` and `assistant` turns. Never infer or persist hidden system/developer prompts or tool traces.
- `AI_CONVERSATION` is the exact wire/frontmatter token; `conversations/` is its canonical folder.
- A raw host conversation ID may enter the API request but MUST NOT be persisted or returned. Persist only a SHA-256 identity hash namespaced by normalized provider.
- Appending requires the complete previously captured prefix. Missing/truncated context, divergence, reordering, or a prefix-hash mismatch returns `409` and writes nothing.
- The capture ledger lives in typed `[conversation]` frontmatter metadata and is independent of the editable body. Local edits, reorder, insertion, and deletion never cause source turns to be overwritten or duplicated.
- Canonical turns are standard Markdown blockquote callouts. Unknown/malformed content is preserved and falls back to ordinary Markdown.
- MCP is an HTTP adapter only. All matching, validation, locking, mutation, indexing, and notification behavior stays in the API/vault layers.
- Existing page creation, assignment, encryption, sync, archive, backlinks, and generic Folio behavior must remain unchanged.
- The UI uses the approved editorial transcript treatment: participant metadata in the margin, restrained assistant rule, normal Folio prose, no chat bubbles.
- Use semantic Vessel tokens/classes. Do not add raw color values to production UI CSS.
- `ui/src/api/schema.d.ts` is generated from OpenAPI and MUST NOT be hand-edited.
- Preserve unrelated user work. Stage only task-owned paths; never use `git add .` or `git add -A`.
- Every task follows red-green-refactor, runs focused verification, receives review, and ends with an exact-path commit.
- Before modifying an exported symbol during execution, run LSP references when the language server supports that file.
- At plan-writing time the repository has an unrelated Rust compile failure at `src/vault/mutation_coordinator.rs:585` (`IndexPolicyError` needs boxing). Do not fold that unrelated fix into this feature. Begin execution only from a clean/reconciled baseline or have the owner resolve it separately.

## File Structure

### Backend domain and API

- Create `src/vault/conversation.rs` — role/turn domain types, provider validation, SHA-256 identities, cumulative capture ledger, canonical marker/body emission, TOML metadata conversion, append decision.
- Modify `src/vault/mod.rs` — export the conversation domain module.
- Modify `src/vault/kind.rs` — add `Kind::AiConversation`, token/folder/inference mappings, tests.
- Create `src/api/conversations.rs` — request/response DTOs, exact indexed identity lookup, process-wide capture serialization, atomic create/append handler and router.
- Modify `src/api/mod.rs` — mount `/conversations`.
- Modify `src/api/pages.rs` — expose a minimal `conversation` summary on `PageDetail` without exposing identity hashes.
- Modify `src/api/openapi.rs` — register capture path and schemas.
- Create `tests/api_conversations_test.rs` — HTTP integration and concurrency coverage using `tests/support`.

### MCP

- Modify `src/mcp/server.rs` — structured tool params, `vault_capture_conversation`, server instructions, tool inventory, real-API adapter tests.

### Frontend model/editor

- Regenerate `ui/src/api/schema.d.ts` — `AI_CONVERSATION`, capture schemas/path, and page conversation summary.
- Modify `ui/src/lib/kind.ts` and `ui/src/lib/kind.test.ts` — runtime kind list, metadata, folder inference.
- Create `ui/src/editor/conversation/marker.ts` — parse/format the exact callout marker grammar and diagnose malformed markers.
- Create `ui/src/editor/conversation/marker.test.ts` — marker grammar and malformed-input tests.
- Modify `ui/src/editor/schema/types.ts` — add `ConversationTurnElement`.
- Create `ui/src/editor/schema/elements/conversationTurn.tsx` — descriptor, rendering, role/action controls, mdast serialization.
- Create `ui/src/editor/schema/elements/conversationTurn.test.tsx` — read/edit rendering and actions.
- Modify `ui/src/editor/schema/registry.ts` — register the descriptor.
- Modify `ui/src/editor/convert/mdast-to-slate.ts` and `ui/src/editor/convert/slate-to-mdast.ts` — recognize and round-trip callout blockquotes.
- Create `ui/src/editor/convert/__tests__/conversation.test.ts` — nested Markdown and lossless round trips.
- Create `ui/src/editor/conversation/presentation.tsx` — Read/Edit/provider context.
- Create `ui/src/editor/conversation/transforms.ts` and `transforms.test.ts` — insert, role correction, move, and removal transforms.
- Modify `ui/src/editor/SlateEditor.tsx` — `readOnly`, conversation context compatibility, and optional editor ref.

### Folio and documentation

- Modify `ui/src/editor/usePageEditor.ts` — expose typed conversation provider summary.
- Modify `ui/src/lib/kindPresentation.tsx` and its test — select conversation body presentation through the existing registry.
- Create `ui/src/components/codex/AiConversationControls.tsx` — Read/Edit toggle and Add Turn action.
- Modify `ui/src/components/codex/Folio.tsx` — conversation mode, provider context, diagnostics/fallback, read-only Slate wiring.
- Create `ui/src/components/codex/__tests__/FolioAiConversation.test.tsx` — default mode, toggle, fallback, provider labels, saving.
- Modify `ui/src/main.css` — editorial transcript and responsive margin treatment.
- Modify `ui/src/docs/content/mcp.mdx` — capture instruction, availability limits, append/conflict behavior, Read/Edit use.
- Modify `.claude/skills/vault/SKILL.md` — add the conversation workflow/tool/kind and correct the existing frontmatter description from YAML to TOML.

---

### Task 1: Conversation Kind and Vault Domain Contract

**Files:**
- Create: `src/vault/conversation.rs`
- Modify: `src/vault/mod.rs`
- Modify: `src/vault/kind.rs`

**Interfaces:**
- Consumes: existing `PageMeta.extra: IndexMap<String, toml::Value>`, `Kind` token/folder conventions, `sha2::Sha256`.
- Produces:

```rust
pub const CONVERSATION_META_KEY: &str = "conversation";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConversationRole { User, Assistant }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationTurn {
    pub role: ConversationRole,
    pub content: String,
    pub source_turn_id: Option<String>,
    pub timestamp: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedTurn {
    pub role: ConversationRole,
    pub content: String,
    pub source_identity: String,
    pub source_sequence: u64,
    pub timestamp: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ConversationLedger {
    pub provider: Option<String>,
    pub host_id_hash: Option<String>,
    pub captured_turn_count: u64,
    pub captured_prefix_hash: String,
    pub last_source_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedTranscript {
    pub turns: Vec<PreparedTurn>,
    pub prefix_hashes: Vec<String>,
    pub ledger: ConversationLedger,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendDecision { Unchanged, AppendFrom(usize) }

pub fn normalize_provider(raw: Option<&str>) -> Result<Option<String>, ConversationError>;
pub fn host_identity_hash(provider: &str, host_id: &str) -> Result<String, ConversationError>;
pub fn prepare_transcript(
    provider: Option<&str>,
    host_id_hash: Option<String>,
    turns: &[ConversationTurn],
) -> Result<PreparedTranscript, ConversationError>;
pub fn verify_append(
    existing: &ConversationLedger,
    submitted: &PreparedTranscript,
) -> Result<AppendDecision, ConversationError>;
pub fn render_turns(turns: &[PreparedTurn]) -> String;
pub fn append_rendered_turns(body: &str, turns: &[PreparedTurn]) -> String;
pub fn read_ledger(meta: &PageMeta) -> Result<Option<ConversationLedger>, ConversationError>;
pub fn write_ledger(meta: &mut PageMeta, ledger: &ConversationLedger) -> Result<(), ConversationError>;
```

- [ ] **Step 1: Write failing kind and domain tests**

Add `pub mod conversation;` to `src/vault/mod.rs`, add `Kind::AiConversation` expectations to `kind.rs`, and create tests in `conversation.rs` covering provider normalization, raw-host-ID hashing, empty content rejection, stable source identity, rejection of a repeated `source_turn_id` within one submitted transcript, duplicate identical content with distinct sequence positions, prefix-hash stability, append decisions, TOML ledger round-trip, and exact Markdown emission.

Representative assertions:

```rust
#[test]
fn complete_prefix_appends_only_the_suffix() {
    let first = prepare_transcript(
        Some("Claude"),
        Some(host_identity_hash("claude", "raw-host-id").unwrap()),
        &[turn(ConversationRole::User, "one"), turn(ConversationRole::Assistant, "two")],
    ).unwrap();
    let second = prepare_transcript(
        Some("claude"),
        first.ledger.host_id_hash.clone(),
        &[
            turn(ConversationRole::User, "one"),
            turn(ConversationRole::Assistant, "two"),
            turn(ConversationRole::User, "three"),
        ],
    ).unwrap();

    assert_eq!(verify_append(&first.ledger, &second).unwrap(), AppendDecision::AppendFrom(2));
}

#[test]
fn marker_is_portable_blockquote_callout() {
    let transcript = prepare_transcript(None, None, &[turn(ConversationRole::User, "Hello")]).unwrap();
    let body = render_turns(&transcript.turns);
    assert!(body.starts_with("> [!AI-USER source=sha256:"));
    assert!(body.contains(" sequence=1]"));
    assert!(body.ends_with("> Hello\n"));
}
```

- [ ] **Step 2: Run tests and observe the red state**

Run:

```bash
cargo test --lib vault::kind vault::conversation
```

Expected: FAIL because `AiConversation` and the conversation domain functions do not exist.

- [ ] **Step 3: Implement the kind mappings**

Add `Kind::AiConversation` to the enum and every exhaustive mapping:

```rust
Kind::AiConversation => "conversations",       // canonical_folder
Kind::AiConversation => "AI_CONVERSATION",     // as_str
"AI_CONVERSATION" => Some(Kind::AiConversation),
"conversations" | "conversation" | "chats" => Some(Kind::AiConversation),
```

Update kind tests for declared resolution, all inferred synonyms, serialization, and deserialization.

- [ ] **Step 4: Implement versioned hashes and validation**

Use SHA-256 with unambiguous length-prefixed inputs, not string concatenation. Preallocate the lowercase hex output and prefix it with `sha256:`. Provider tokens normalize to lowercase and accept only 1–64 ASCII characters from `[a-z0-9._-]`. Reject blank host IDs and blank turn content. Reject any repeated non-empty `source_turn_id` within one submitted transcript, even if its content is identical.

Use these versioned domains:

```text
clepsydra-conversation-host-v1     + len(provider) + provider + len(host_id) + host_id
clepsydra-conversation-turn-v1     + role + len(source_turn_id/content) + value
clepsydra-conversation-prefix-v1   + ordered(sequence, source_identity, role, exact content)
```

When `source_turn_id` exists, derive `source_identity` from the normalized provider (or empty provider namespace) plus that ID. Otherwise derive it from role plus exact content. Always include sequence, role, and exact content in the cumulative prefix hash so repeated text stays ordered and upstream edits conflict. Define `prefix_hashes[i]` as the cumulative hash of turns `0..=i`; the vector length always equals the turn count.

- [ ] **Step 5: Implement ledger TOML and canonical Markdown**

Serialize `ConversationLedger` into `PageMeta.extra["conversation"]` as one native TOML table. `read_ledger` returns `Ok(None)` when absent and a typed error for malformed fields.

Emit one marker line per turn:

```text
[!AI-USER source=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef sequence=1 timestamp=2026-08-09T09:14:00Z]
[!AI-ASSISTANT source=sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210 sequence=2]
```

Every marker and content line is blockquote-prefixed. Split multi-line content and emit `>` for blank lines. Ensure exactly one blank line between turns and one final newline.

- [ ] **Step 6: Implement safe append decisions**

`verify_append` must require provider/hash equality, `submitted.captured_turn_count >= existing.captured_turn_count`, and the submitted prefix hash at the existing count to match the ledger. For an existing count `n > 0`, compare `submitted.prefix_hashes[n - 1]` to `existing.captured_prefix_hash`; do not compare or parse the editable body.

Return `Unchanged` only when counts and final hashes match. Return `AppendFrom(existing_count as usize)` only for a valid suffix. Return a typed conflict for truncated or divergent input.

- [ ] **Step 7: Run focused tests**

Run:

```bash
cargo test --lib vault::conversation
cargo test --lib vault::kind
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/vault/conversation.rs src/vault/mod.rs src/vault/kind.rs
git commit -m "feat(vault): model AI conversation transcripts"
```

---

### Task 2: Atomic Conversation Capture API

**Files:**
- Create: `src/api/conversations.rs`
- Create: `tests/api_conversations_test.rs`
- Modify: `src/api/mod.rs`
- Modify: `src/api/pages.rs`
- Modify: `src/api/openapi.rs`

**Interfaces:**
- Consumes: Task 1 domain APIs; `build_projected_note_path`; `MutationCoordinator::{create_page,update_page}`; `PageMeta.extra`; `page_properties` index.
- Produces:

```rust
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ConversationRoleRequest { User, Assistant }

#[derive(Debug, Deserialize, ToSchema)]
pub struct CaptureConversationTurnRequest {
    pub role: ConversationRoleRequest,
    pub content: String,
    pub source_turn_id: Option<String>,
    pub timestamp: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CaptureConversationRequest {
    pub title: String,
    pub provider: Option<String>,
    pub host_conversation_id: Option<String>,
    pub turns: Vec<CaptureConversationTurnRequest>,
}

#[derive(Debug, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CaptureConversationOperation { Created, Appended, Unchanged }

#[derive(Debug, Serialize, ToSchema)]
pub struct CaptureConversationResponse {
    pub path: String,
    pub page_id: String,
    pub operation: CaptureConversationOperation,
    pub appended_turns: usize,
    pub skipped_turns: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ConversationSummaryResponse {
    pub provider: Option<String>,
}
```

- Endpoint: `POST /api/vault/conversations/capture`.
- `PageDetail` and `PageDetailResponse` gain `conversation: Option<ConversationSummaryResponse>`; never expose `host_id_hash`, prefix hash, or raw host ID.

- [ ] **Step 1: Write failing HTTP integration tests**

In `tests/api_conversations_test.rs`, use `mod support;` and `ApiFixture::builder()` like `api_journal_test.rs`. Add tests for:

1. creation under `conversations/` with `type = "AI_CONVERSATION"`;
2. response `operation = "created"`, counts, and provider summary;
3. raw host ID absent from file bytes and response JSON;
4. identical re-capture returns `unchanged` without a second notification;
5. complete-prefix capture appends one suffix turn;
6. edited existing body remains edited after append;
7. truncated/divergent transcript returns `409` with unchanged bytes;
8. no host ID creates a new page every time;
9. ID without provider, empty title/transcript/content, and invalid provider return `400` with no file;
10. duplicate exact identity pages return `409`;
11. protected matching page returns `409`;
12. two concurrent first captures for one identity create exactly one page and the other returns `unchanged` or appends safely, never a duplicate.

Representative request:

```rust
fn payload(turns: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "title": "Conversation about capture semantics",
        "provider": "Claude",
        "host_conversation_id": "raw-provider-id-must-not-persist",
        "turns": turns,
    })
}
```

- [ ] **Step 2: Run the endpoint tests and observe failure**

Run:

```bash
cargo test --test api_conversations_test -- --nocapture
```

Expected: FAIL with `404` for `/api/vault/conversations/capture`.

- [ ] **Step 3: Implement DTO validation and identity lookup**

Create `src/api/conversations.rs`. Convert request roles into Task 1 domain roles and let the domain validate content/provider/timestamp.

For exact lookup, query the already-derived nested `conversation` property:

```sql
SELECT p.path
FROM pages p
JOIN page_properties pp ON pp.page_id = p.id
WHERE p.kind = 'AI_CONVERSATION'
  AND pp.key = 'conversation'
  AND json_extract(pp.value_json, '$.provider') = ?1
  AND json_extract(pp.value_json, '$.host_id_hash') = ?2
ORDER BY p.path
```

Return all matches; zero/one/multiple are distinct states. Map malformed indexed paths to internal errors.

- [ ] **Step 4: Serialize concurrent identity operations**

Add one process-wide mutex beside the handler, following the existing Journal ensure lock:

```rust
static CONVERSATION_CAPTURE_LOCK: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());
```

When a host identity exists, acquire this guard before exact index lookup and retain it through create/unchanged/append completion. Requests without a host identity skip the lock and always create at a fresh generated path. This deliberately serializes identified conversation captures: it is boring, avoids a lookup/create race, and does not nest coordinator path locks or risk lock-order deadlock. Add a comment documenting why lookup and mutation share the guard.

- [ ] **Step 5: Implement atomic creation**

Capture one `created = state.clock.now()`. Build the path with:

```rust
build_projected_note_path(
    title,
    created,
    Kind::AiConversation,
    None,
    &generate_short_id(),
)
```

Create `PageMeta` with title, timestamps, `kind = Some(Kind::AiConversation)`, and Task 1 ledger metadata. Body is `render_turns(&prepared.turns)`. Call `MutationCoordinator::create_page` and standard `mutation_notifier`. Return `201` and `Created`.

- [ ] **Step 6: Implement unchanged and append paths**

For one match, read exact file bytes and parse `Page`. Reject encrypted pages. Read the ledger from metadata and call `verify_append`.

- `Unchanged`: return `200` without calling the coordinator or emitting a notification.
- `AppendFrom(i)`: append `prepared.turns[i..]`, replace the ledger with the submitted final ledger, update `updated_at`, and call `MutationCoordinator::update_page` using the exact current bytes as `expected_content`, `ProjectAssignment::Unchanged`, and `reconcile: false`.

Do not change the existing page title on re-capture. Map stale/index conflicts through the existing `mutation_error` adapter.

- [ ] **Step 7: Expose safe page summary metadata**

Before moving `page.meta` in `page_detail`, parse only `conversation.provider` into `ConversationSummaryResponse`. If metadata is absent or malformed, return `conversation: None`; ordinary reads must remain non-destructive. Add the same optional field to the OpenAPI-only `PageDetailResponse`.

- [ ] **Step 8: Mount and document the API path**

Add `pub mod conversations;` and `.nest("/conversations", conversations::router())` in `src/api/mod.rs`. Add `#[utoipa::path]` on the handler, register the path and all request/response schemas in `src/api/openapi.rs`, and extend the OpenAPI test with:

```rust
assert!(spec.paths.paths.contains_key("/api/vault/conversations/capture"));
assert!(spec.components.unwrap().schemas.contains_key("CaptureConversationResponse"));
```

- [ ] **Step 9: Run focused API tests**

Run:

```bash
cargo test --test api_conversations_test -- --nocapture
cargo test --lib api::openapi
```

Expected: PASS, including concurrent capture and no-artifact assertions.

- [ ] **Step 10: Commit**

```bash
git add src/api/conversations.rs src/api/mod.rs src/api/pages.rs src/api/openapi.rs tests/api_conversations_test.rs
git commit -m "feat(api): capture AI conversations atomically"
```

---

### Task 3: Structured MCP Conversation Tool

**Files:**
- Modify: `src/mcp/server.rs`

**Interfaces:**
- Consumes: Task 2 `POST /api/vault/conversations/capture` wire contract.
- Produces: MCP tool `vault_capture_conversation` with `CaptureConversationParams` and ordered `CaptureConversationTurnParams`.

```rust
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ConversationRoleParam { User, Assistant }

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct CaptureConversationTurnParams {
    /// Visible participant role. System/developer/tool turns are not accepted.
    pub role: ConversationRoleParam,
    /// Exact visible turn content as Markdown; do not summarize.
    pub content: String,
    pub source_turn_id: Option<String>,
    pub timestamp: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct CaptureConversationParams {
    pub title: String,
    pub provider: Option<String>,
    pub host_conversation_id: Option<String>,
    pub turns: Vec<CaptureConversationTurnParams>,
}
```

- [ ] **Step 1: Write failing tool-router and real-adapter tests**

Extend `tool_router_exposes_the_read_and_write_surface` with `vault_capture_conversation`. Add tests that inspect its generated schema to ensure role is restricted to `user | assistant` and `turns` is required.

Using the existing `serve_seeded_vault()` helper, call:

```rust
server.vault_capture_conversation(Parameters(CaptureConversationParams {
    title: "MCP transcript".into(),
    provider: Some("claude".into()),
    host_conversation_id: Some("mcp-host-id".into()),
    turns: vec![
        capture_turn(ConversationRoleParam::User, "Question"),
        capture_turn(ConversationRoleParam::Assistant, "Answer"),
    ],
})).await
```

Assert the first call renders `"operation": "created"`, a second call with one extra turn renders `"operation": "appended"`, and no rendered response contains `mcp-host-id`.

- [ ] **Step 2: Run MCP tests and observe failure**

Run:

```bash
cargo test --lib mcp::server::tests::tool_router_exposes_the_read_and_write_surface
cargo test --lib mcp::server::tests::capture_conversation
```

Expected: FAIL because the tool and params do not exist.

- [ ] **Step 3: Implement the thin MCP adapter**

Add a `#[tool]` method that performs no matching or Markdown generation:

```rust
#[tool(
    name = "vault_capture_conversation",
    description = "Capture the complete visible user/assistant conversation as an AI_CONVERSATION Folio. Send ordered turns verbatim, not a summary. Clepsydra creates once and appends only when provider + host_conversation_id identify an exact existing capture; truncated or divergent context conflicts rather than guessing. Hidden system/developer prompts and tool traces are not accepted.",
    annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false)
)]
pub async fn vault_capture_conversation(
    &self,
    Parameters(params): Parameters<CaptureConversationParams>,
) -> Result<String, String> {
    let value = self.client
        .post_json("/api/vault/conversations/capture", &serde_json::to_value(params).map_err(|e| e.to_string())?)
        .await
        .map_err(|e| e.to_string())?;
    render(&value)
}
```

Derive `Serialize` as needed for forwarding. Keep timestamp as the caller's RFC3339 string; API owns validation.

- [ ] **Step 4: Update MCP server instructions**

Add the tool to `ServerHandler::get_info()` instructions. State that a user request such as “send this conversation to Clepsydra” maps to `vault_capture_conversation`, complete visible turns must be supplied, and generic `vault_create_page` is not the conversation-capture path.

- [ ] **Step 5: Run focused MCP tests**

Run:

```bash
cargo test --lib mcp::server::tests
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.rs
git commit -m "feat(mcp): capture visible AI conversations"
```

---

### Task 4: Publish OpenAPI and Frontend Kind Contract

**Files:**
- Regenerate: `ui/src/api/schema.d.ts`
- Modify: `ui/src/lib/kind.ts`
- Modify: `ui/src/lib/kind.test.ts`

**Interfaces:**
- Consumes: Task 1 `Kind::AiConversation`; Task 2 OpenAPI path/schemas.
- Produces: generated `Kind` union containing `AI_CONVERSATION`, generated capture endpoint/types, runtime `KINDS` entry and folder metadata.

- [ ] **Step 1: Add failing frontend kind tests**

Add assertions:

```ts
expect(KINDS).toContain("AI_CONVERSATION");
expect(resolveKindFromPath("conversations/example.md")).toBe("AI_CONVERSATION");
expect(resolveKindFromPath("chats/example.md")).toBe("AI_CONVERSATION");
expect(kindLabel("AI_CONVERSATION")).toBe("AI CONVERSATION");
```

- [ ] **Step 2: Run the kind test and observe failure**

Run:

```bash
bun --cwd ui test src/lib/kind.test.ts
```

Expected: FAIL because the generated union/runtime list does not include the kind.

- [ ] **Step 3: Regenerate OpenAPI types from the real server**

Start the backend with the harness process supervisor against a temporary initialized vault, then run:

```bash
bun --cwd ui run openapi
```

Stop the supervised backend afterward. Confirm through generated typecheck—not manual edits—that `schema.d.ts` contains:

```text
AI_CONVERSATION
/api/vault/conversations/capture
CaptureConversationRequest
CaptureConversationResponse
ConversationSummaryResponse
```

- [ ] **Step 4: Add runtime kind metadata**

Add `AI_CONVERSATION` to `KINDS` and `KIND_META`; use a semantic token such as `var(--cool)`. Add folder keys `conversations`, `conversation`, and `chats`.

Replace any stale manually enumerated “all kinds” tests with iteration over `KINDS` so future backend additions cannot be silently omitted.

- [ ] **Step 5: Run focused verification**

Run:

```bash
bun --cwd ui test src/lib/kind.test.ts
bun --cwd ui run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/api/schema.d.ts ui/src/lib/kind.ts ui/src/lib/kind.test.ts
git commit -m "feat(ui): publish AI conversation kind contract"
```

---

### Task 5: Conversation Marker and Slate Round Trip

**Files:**
- Create: `ui/src/editor/conversation/marker.ts`
- Create: `ui/src/editor/conversation/marker.test.ts`
- Modify: `ui/src/editor/schema/types.ts`
- Create: `ui/src/editor/schema/elements/conversationTurn.tsx`
- Modify: `ui/src/editor/schema/registry.ts`
- Modify: `ui/src/editor/convert/mdast-to-slate.ts`
- Modify: `ui/src/editor/convert/slate-to-mdast.ts`
- Create: `ui/src/editor/convert/__tests__/conversation.test.ts`

**Interfaces:**
- Produces:

```ts
export type ConversationRole = "user" | "assistant";
export type ConversationOrigin = "source" | "local";

export interface ConversationMarker {
  role: ConversationRole;
  source: string;
  sequence: number | null;
  timestamp: string | null;
  origin: ConversationOrigin;
}

export interface ConversationTurnElement {
  type: "conversation-turn";
  role: ConversationRole;
  source: string;
  sourceSequence?: number;
  timestamp?: string;
  origin: ConversationOrigin;
  children: Descendant[];
}

export function parseConversationMarker(text: string): ConversationMarker | null;
export function formatConversationMarker(marker: ConversationMarker): string;
export function diagnoseConversationMarkdown(markdown: string): {
  validMarkers: number;
  malformedMarkerLines: number[];
};
```

- Exact grammar:

```text
[!AI-USER source=sha256:<64 lowercase hex> sequence=<positive integer> timestamp=<optional RFC3339>]
[!AI-ASSISTANT source=sha256:<64 lowercase hex> sequence=<positive integer> timestamp=<optional RFC3339>]
[!AI-USER source=local:<UUID>]
[!AI-ASSISTANT source=local:<UUID>]
```

- [ ] **Step 1: Write failing marker grammar tests**

Test valid source/local forms, user/assistant roles, optional timestamp, lowercase hash requirement, positive sequence requirement for source captures, forbidden sequence for local markers, extra/duplicate attributes, unknown roles, and malformed lines reported without throwing.

- [ ] **Step 2: Write failing mdast/Slate conversion tests**

Use canonical Markdown with multi-paragraph content, headings, nested lists, code fences, math, wikilinks, and an ordinary blockquote. Assert only valid AI callouts become `conversation-turn`; ordinary/malformed blockquotes remain `blockquote`; round-trip output reparses to the same Slate structure.

Representative assertion:

```ts
const [turn, quote] = mdastToSlate(input);
expect(turn).toMatchObject({
  type: "conversation-turn",
  role: "assistant",
  sourceSequence: 2,
  origin: "source",
});
expect(quote).toMatchObject({ type: "blockquote" });
expect(mdastToSlate(slateToMarkdown([turn, quote]))).toEqual([turn, quote]);
```

- [ ] **Step 3: Run tests and observe failure**

Run:

```bash
bun --cwd ui test src/editor/conversation/marker.test.ts src/editor/convert/__tests__/conversation.test.ts
```

Expected: FAIL because marker parsing and `conversation-turn` do not exist.

- [ ] **Step 4: Implement the pure marker module**

Use one anchored parser; do not parse arbitrary callout prose. Normalize timestamp output but preserve an accepted RFC3339 value exactly. Diagnostics scan only blockquote marker candidate lines (`/^>\s*\[!AI-/`) so ordinary prose containing `[!AI-` is not warned.

- [ ] **Step 5: Add the Slate element and descriptor**

Add `ConversationTurnElement` to `CustomElement`, register its descriptor, and initially render semantic structure without edit actions:

```tsx
<article {...attributes} className="ai-conversation-turn" data-role={element.role}>
  <aside contentEditable={false} className="ai-conversation-turn__participant">
    {element.role === "user" ? "You" : "Assistant"}
  </aside>
  <div className="ai-conversation-turn__content">{children}</div>
</article>
```

The descriptor's `toMdast` emits one blockquote whose first paragraph is the formatted marker and whose remaining children come from `ctx.blockChildren(node.children)`.

- [ ] **Step 6: Recognize callout blockquotes during mdast conversion**

Before generic blockquote conversion, claim a blockquote only when its first child is a one-text-child paragraph whose complete text passes `parseConversationMarker`. Remove that marker paragraph and convert all remaining block children into the `conversation-turn` children. Supply an empty paragraph when the turn body is empty so Slate invariants hold, while API-created turns remain non-empty.

- [ ] **Step 7: Run round-trip and existing conversion suites**

Run:

```bash
bun --cwd ui test src/editor/conversation/marker.test.ts src/editor/convert/__tests__/conversation.test.ts src/editor/convert/__tests__/round-trip.test.ts src/editor/convert/__tests__/mdast-to-slate.test.ts src/editor/convert/__tests__/slate-to-mdast.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/src/editor/conversation/marker.ts ui/src/editor/conversation/marker.test.ts ui/src/editor/schema/types.ts ui/src/editor/schema/elements/conversationTurn.tsx ui/src/editor/schema/registry.ts ui/src/editor/convert/mdast-to-slate.ts ui/src/editor/convert/slate-to-mdast.ts ui/src/editor/convert/__tests__/conversation.test.ts
git commit -m "feat(editor): round-trip conversation turns"
```

---

### Task 6: Conversation Read/Edit Presentation and Transforms

**Files:**
- Create: `ui/src/editor/conversation/presentation.tsx`
- Create: `ui/src/editor/conversation/transforms.ts`
- Create: `ui/src/editor/conversation/transforms.test.ts`
- Modify: `ui/src/editor/schema/elements/conversationTurn.tsx`
- Create: `ui/src/editor/schema/elements/conversationTurn.test.tsx`
- Modify: `ui/src/editor/SlateEditor.tsx`

**Interfaces:**
- Produces:

```ts
export type ConversationDisplayMode = "read" | "edit";
export interface ConversationPresentation {
  mode: ConversationDisplayMode;
  provider: string | null;
}
export const ConversationPresentationProvider: React.Provider<ConversationPresentation>;
export function useConversationPresentation(): ConversationPresentation;

export function insertConversationTurn(editor: Editor, options?: { after?: Path; role?: ConversationRole }): void;
export function setConversationRole(editor: Editor, path: Path, role: ConversationRole): void;
export function moveConversationTurn(editor: Editor, path: Path, direction: -1 | 1): void;
export function removeConversationTurn(editor: Editor, path: Path): void;
```

- `SlateEditorProps` gains:

```ts
readOnly?: boolean;
editorRef?: React.MutableRefObject<CustomEditor | null>;
```

- [ ] **Step 1: Write failing transform tests**

Create an in-memory Slate editor with three conversation turns. Assert insert-after uses `crypto.randomUUID()` as `local:<uuid>` and no source sequence, role correction changes only role, move respects document boundaries, removal preserves at least one paragraph when the document becomes empty, and none of these operations mutates source identities.

Mock `crypto.randomUUID` to keep tests deterministic.

- [ ] **Step 2: Write failing read/edit element tests**

Render a conversation turn under `ConversationPresentationProvider`:

- Read + provider `claude`: label `Claude`, no role select/action buttons, `contentEditable=false` on margin metadata.
- Read + no provider: label `Assistant`.
- Edit: role select plus move-up/move-down/add-after/remove controls are visible and invoke the transform functions.
- User role always labels `You`.

Use accessible names such as `Change participant`, `Move turn up`, `Move turn down`, `Add turn after`, and `Remove turn`.

- [ ] **Step 3: Run tests and observe failure**

Run:

```bash
bun --cwd ui test src/editor/conversation/transforms.test.ts src/editor/schema/elements/conversationTurn.test.tsx
```

Expected: FAIL because context, transforms, and edit controls do not exist.

- [ ] **Step 4: Implement context and transforms**

Default context must be `{ mode: "edit", provider: null }` so conversation elements rendered in editor stories/tests remain editable unless Folio explicitly selects Read mode.

Move only among top-level conversation-turn siblings. If neighboring root nodes are ordinary Markdown fallback nodes, skip over them rather than moving fallback content implicitly.

- [ ] **Step 5: Implement semantic participant/action rendering**

Use the provider only as the assistant display label; role remains the stored semantic discriminator. Normalize known labels to `Claude` and `ChatGPT`; title-case an unknown provider token without changing stored metadata.

All control chrome is `contentEditable={false}`. Use semantic tokens/classes only; visual CSS lands in Task 7.

- [ ] **Step 6: Add `SlateEditor` read-only/ref support**

Assign `editorRef.current = editor` during render and clear it on unmount. Pass `readOnly` to `<Editable>`. In Read mode:

- omit `onKeyDown`, `onDOMBeforeInput`, and Vim handlers;
- hide Vim status and all comboboxes;
- keep selection/copy behavior;
- allow Slate selection operations without calling content mutation paths.

In `handleChange`, call the parent only when `!readOnly`; this prevents selection-only Read mode operations from dirtying the Folio.

- [ ] **Step 7: Run focused and regression tests**

Run:

```bash
bun --cwd ui test src/editor/conversation/transforms.test.ts src/editor/schema/elements/conversationTurn.test.tsx src/editor/SlateEditor.selection-replacement.test.tsx src/editor/SlateEditor.vim-toggle.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/src/editor/conversation/presentation.tsx ui/src/editor/conversation/transforms.ts ui/src/editor/conversation/transforms.test.ts ui/src/editor/schema/elements/conversationTurn.tsx ui/src/editor/schema/elements/conversationTurn.test.tsx ui/src/editor/SlateEditor.tsx
git commit -m "feat(editor): present and edit conversation turns"
```

---

### Task 7: Folio Conversation Modes and Editorial Styling

**Files:**
- Modify: `ui/src/editor/usePageEditor.ts`
- Modify: `ui/src/lib/kindPresentation.tsx`
- Modify: `ui/src/lib/kindPresentation.test.tsx`
- Create: `ui/src/components/codex/AiConversationControls.tsx`
- Modify: `ui/src/components/codex/Folio.tsx`
- Create: `ui/src/components/codex/__tests__/FolioAiConversation.test.tsx`
- Modify: `ui/src/main.css`

**Interfaces:**
- `UsePageEditorResult` gains `conversationProvider: string | null` sourced from `page?.conversation?.provider`.
- `KindPresentation` gains `bodyPresentation: "editor" | "ai-conversation"`; generic is `editor`, `AI_CONVERSATION` is `ai-conversation`.
- `AiConversationControls` props:

```ts
interface AiConversationControlsProps {
  mode: "read" | "edit";
  onModeChange(mode: "read" | "edit"): void;
  onAddTurn(): void;
}
```

- [ ] **Step 1: Write failing presentation-registry tests**

Assert `presentationFor("AI_CONVERSATION").bodyPresentation === "ai-conversation"`, Journal retains its metadata/title behavior, and every value in `KINDS` resolves without throwing.

- [ ] **Step 2: Write failing Folio behavior tests**

Use the existing Folio test harness/mocks and a page response with:

```ts
{
  kind: "AI_CONVERSATION",
  conversation: { provider: "claude" },
  body: canonicalConversationMarkdown,
}
```

Assert:

1. default mode is Read and Slate is read-only;
2. participant labels are `You` and `Claude`;
3. Edit enables role/action controls;
4. Add Turn inserts a local assistant turn through the editor ref;
5. switching back to Read preserves unsaved Slate state;
6. save serializes canonical markers;
7. malformed marker shows a warning and ordinary Markdown without hiding text;
8. an assigned AI page with zero valid markers shows a repair warning;
9. generic Note and Journal Folios retain their current behavior;
10. locked/protected AI Folios still render `LockedFolio` before any transcript UI.

- [ ] **Step 3: Run tests and observe failure**

Run:

```bash
bun --cwd ui test src/lib/kindPresentation.test.tsx src/components/codex/__tests__/FolioAiConversation.test.tsx
```

Expected: FAIL because the body presentation and controls do not exist.

- [ ] **Step 4: Expose provider metadata and registry selection**

Add `conversationProvider` to `usePageEditor`. Extend `KindPresentation` with a required `bodyPresentation`, set the generic value to `editor`, and register:

```ts
AI_CONVERSATION: {
  bodyPresentation: "ai-conversation",
  metaExtras: null,
}
```

Keep Journal's existing values plus `bodyPresentation: "editor"`.

- [ ] **Step 5: Implement Folio mode wiring**

In `Folio`, initialize local mode to `read`; it is harmless for generic kinds and the Folio already remounts when the path changes. For AI presentation:

- render `AiConversationControls` near the document header;
- keep a `CustomEditor | null` ref;
- wrap `SlateEditor` in `ConversationPresentationProvider` with mode/provider;
- pass `readOnly={mode === "read"}`;
- add a first local turn through `insertConversationTurn(editorRef.current)` when no valid turns exist;
- compute diagnostics from `editor.bodyMarkdown` and show a non-destructive warning with an Edit action.

Do not create a second Markdown renderer: one Slate tree must drive both modes so toggling does not lose unsaved edits.

- [ ] **Step 6: Implement editorial transcript CSS**

Add semantic classes for:

```text
.ai-conversation-controls
.ai-conversation-turn
.ai-conversation-turn__participant
.ai-conversation-turn__content
.ai-conversation-turn[data-role="assistant"]
.ai-conversation--read
.ai-conversation--edit
```

Desktop Read mode uses a fixed 7–8rem participant column and prose content column. Assistant content gets a 2px semantic `--cool`/`--accent` rule. Edit mode uses compact control chrome but the same content measure. Under the existing mobile breakpoint, collapse participant metadata above content and retain at least 44px controls. No bubble backgrounds or alternating alignment.

- [ ] **Step 7: Run focused frontend verification**

Run:

```bash
bun --cwd ui test src/lib/kindPresentation.test.tsx src/components/codex/__tests__/FolioAiConversation.test.tsx
bun --cwd ui run typecheck
bun --cwd ui run lint
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/src/editor/usePageEditor.ts ui/src/lib/kindPresentation.tsx ui/src/lib/kindPresentation.test.tsx ui/src/components/codex/AiConversationControls.tsx ui/src/components/codex/Folio.tsx ui/src/components/codex/__tests__/FolioAiConversation.test.tsx ui/src/main.css
git commit -m "feat(folio): add AI conversation read and edit modes"
```

---

### Task 8: MCP User and Agent Documentation

**Files:**
- Modify: `ui/src/docs/content/mcp.mdx`
- Modify: `.claude/skills/vault/SKILL.md`
- Test: `ui/src/docs/mdx-smoke.test.tsx`
- Test: `ui/src/docs/registry.test.ts`

**Interfaces:**
- Consumes: final MCP tool name/schema and Folio behavior from Tasks 3 and 7.
- Produces: user-facing instruction “Send this conversation to Clepsydra” and agent workflow guidance.

- [ ] **Step 1: Write the documentation contract before prose**

The MCP guide must include all of these exact facts:

- `vault_capture_conversation` is the tool for a visible current chat;
- only visible user/assistant turns are capturable;
- Clepsydra cannot retrieve omitted, truncated, hidden, tool, or attachment content;
- provider + host conversation ID enables safe append when exposed;
- missing ID creates a new Folio;
- divergence/truncation conflicts rather than guessing;
- the Folio defaults to Read and offers Edit;
- Markdown remains portable blockquote callouts.

The vault skill must add `AI_CONVERSATION → conversations/`, map current-conversation requests to `vault_capture_conversation`, instruct the agent to send complete ordered visible turns verbatim, and forbid generic `vault_create_page` for this workflow.

- [ ] **Step 2: Update the in-app MCP guide**

Add the tool to the inventory table and a “Capture a conversation” workflow with example natural-language prompts:

```text
Send this conversation to Clepsydra.
Send this conversation to Clepsydra as “AI conversation Folio design”.
```

Explain the returned created/appended/unchanged result and conflict recovery: ask the user to re-run from a host context containing the complete earlier prefix; do not advise fuzzy matching or overwrite.

- [ ] **Step 3: Update the vault skill**

Load the `writing-skills` skill before editing. Correct line 8 from “YAML frontmatter” to “TOML frontmatter.” Add the kind/tool/workflow while keeping the skill concise and trigger-focused.

After editing, invoke the read-only `skill-reviewer` and apply only evidence-backed improvements that preserve the approved behavior.

- [ ] **Step 4: Run documentation verification**

Run:

```bash
bun --cwd ui test src/docs/mdx-smoke.test.tsx src/docs/registry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/docs/content/mcp.mdx .claude/skills/vault/SKILL.md
git commit -m "docs: explain AI conversation capture"
```

---

### Task 9: End-to-End Verification, Review, and Integration

**Files:**
- Verify all files changed by Tasks 1–8.
- Modify only if focused verification identifies a feature-owned defect.

**Interfaces:**
- Consumes: completed backend, MCP, generated API, editor, Folio, and docs.
- Produces: verified feature branch ready to merge into `develop`.

- [ ] **Step 1: Review every task against the approved spec**

Use a fresh code-review subagent after each implementation task during execution. At the final review, verify:

- raw host IDs cannot appear in page files, API responses, logs, or MCP results;
- no duplicate identity race remains between lookup and create;
- unchanged capture emits no mutation notification;
- append never derives its ledger from locally edited body text;
- malformed Markdown cannot be dropped by either converter;
- generic Folios and protected Folios remain unchanged;
- every new control has an accessible name and keyboard target.

Fix only confirmed feature-owned findings and rerun their focused tests.

- [ ] **Step 2: Run Rust formatting, typecheck, lint, and full tests**

Run:

```bash
cargo fmt --check
cargo check --all-targets
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets
```

Expected: all commands exit 0. If the pre-existing `IndexPolicyError` baseline failure remains, stop and have the owner resolve/rebase it; do not hide it or include an unrelated fix in the feature commit.

- [ ] **Step 3: Run frontend formatting check, typecheck, lint, and full tests**

Run:

```bash
bun --cwd ui run typecheck
bun --cwd ui run lint
bun --cwd ui run test
bun --cwd ui run build
```

Expected: all commands exit 0.

- [ ] **Step 4: Smoke the real API capture path**

Run `cargo build --bin clep`. Create a unique directory with `mktemp -d` and record the returned absolute path as `SMOKE_ROOT` for subsequent tool arguments. Run `target/debug/clep init` with the path `SMOKE_ROOT/vault`. Use the file-write tool to create `SMOKE_ROOT/config.toml` containing that absolute vault root plus server host `127.0.0.1` and port `33179`. Start `target/debug/clep serve --port 33179` with `SMOKE_ROOT` as its working directory through the harness process supervisor.

POST a two-turn transcript to `/api/vault/conversations/capture`, then POST the same prefix plus one suffix turn. Observe:

```json
{ "operation": "created", "appended_turns": 2 }
{ "operation": "appended", "appended_turns": 1, "skipped_turns": 2 }
```

Read the created file and verify the raw host conversation ID is absent, the kind is `AI_CONVERSATION`, and exactly three canonical markers exist.

- [ ] **Step 5: Smoke the MCP adapter**

Run the real-API MCP integration test added in Task 3 against the completed binary/API contract:

```bash
cargo test --lib mcp::server::tests::capture_conversation -- --nocapture
```

Expected: created then appended results with no raw host ID.

- [ ] **Step 6: Smoke the Folio in a browser**

With the temporary server still running and the built UI available, open the created conversation path in the real browser. Verify visually and interactively:

1. Read mode is selected by default.
2. `You` and provider labels are distinct in the editorial margin treatment.
3. Long assistant Markdown, code, and lists retain Folio measure.
4. Edit enables role/action controls.
5. Add, reorder, role-correct, and remove a local turn.
6. Save, reload, and confirm the Markdown round-trip.
7. Re-capture through the API and confirm the local edit remains while only the source suffix is added.
8. Resize to a mobile viewport and confirm participant metadata collapses above content without horizontal overflow.

Visual/behavioral observation is the proof; record exact paths and outcomes in the delivery report.

- [ ] **Step 7: Stop temporary services and perform cleanup**

Stop supervised server/browser processes. Remove only the temporary smoke vault/config. Do not remove `.superpowers/brainstorm/` design artifacts unless the user requests it; that directory is gitignored and preserves the approved mockup.

If verification required code changes, inspect `git status --short`, stage each confirmed feature-owned path explicitly, and commit them with:

```bash
git commit -m "fix: resolve AI conversation verification findings"
```

Do not stage unrelated paths and do not create an empty cleanup commit.

- [ ] **Step 8: Finish and merge the feature branch**

Invoke `superpowers:finishing-a-development-branch`. Present verification evidence, then merge the reviewed feature branch into the repository integration branch `develop` as required by project workflow. Do not merge with failing gates.
