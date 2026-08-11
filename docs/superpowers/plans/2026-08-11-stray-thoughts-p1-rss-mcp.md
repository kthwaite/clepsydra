# Stray Thoughts P1 RSS and MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep read RSS entries visible by default behind an explicit Hide read filter, and give MCP clients normative LLM page/project authoring rules.

**Architecture:** Preserve the existing `EntryViewDto::{All,Unread,Saved}` transport and filter-aware React Query cache; change only defaults and control copy so Hide read maps to `unread`. Keep `VaultMcpServer::get_info` authoritative for agent guidance and mirror the same policy in tool descriptions, the in-app MCP page, and the repository vault skill.

**Tech Stack:** Rust 2024, Axum, rmcp, Utoipa, React 19, TypeScript, TanStack Router/Query, React Aria Components, Vitest/Testing Library, Bun, Cargo.

## Global Constraints

- Default RSS view is `all`; explicit Hide read maps to `unread`; Saved remains a separate view.
- Changing the view filter never mutates entry read state.
- Preserve filter-aware optimistic cache behavior and cursor pagination.
- Every standalone page authored by an LLM through MCP carries `ai-generated`.
- Edits, journal captures, and conversation captures do not add `ai-generated` merely because an LLM performed them.
- MCP clients search before create, use the real Kind, assign project through metadata, and link substantial project documentation to its project/hub page.
- `VaultMcpServer::get_info` is the authoritative instruction source; tool descriptions and human-facing docs must not contradict it.
- Existing unstaged files in the primary checkout are out of scope.
- Follow red-green-refactor and commit each independently reviewable task.

---

### Task 1: Make Hide read an opt-in RSS filter

**Files:**
- Modify: `src/api/feeds.rs` (`list_entries` default)
- Modify: `ui/src/routes/feeds.tsx` (`Route.validateSearch`, view controls)
- Modify: `ui/src/components/codex/FeedRiverPanel.tsx` (`VIEWS`, initial `view`)
- Modify: `ui/src/components/codex/FeedRiver.tsx` only if copy currently exposes `unread` rather than Hide read
- Test: `tests/feeds_http_test.rs` or the existing HTTP feed-route test containing list defaults
- Test: `ui/src/routes/-feeds.test.tsx`
- Test: `ui/src/components/codex/FeedRiverPanel.test.tsx`
- Test: `ui/src/components/codex/FeedRiver.test.tsx`
- Test: `ui/src/api/feeds.test.ts`

**Interfaces:**
- Preserve `EntryViewDto::{All, Unread, Saved}` and generated `EntryView` wire values `"all" | "unread" | "saved"`.
- `view=unread` means Hide read is active; `view=all` means Hide read is inactive.
- `feedEntriesInfiniteOptions(filters)` and `belongsInEntryCache(entry, filters)` retain their signatures and existing filter-aware behavior.

- [ ] **Step 1: Add failing backend default test**

Seed one read and one unread entry, request `GET /api/vault/feeds/entries` without `view`, and assert both IDs are returned. Also retain an explicit `?view=unread` assertion returning only the unread ID:

```rust
let all = get_json(&app, "/api/vault/feeds/entries").await;
assert_eq!(entry_ids(&all), [read_id, unread_id]);

let hidden = get_json(&app, "/api/vault/feeds/entries?view=unread").await;
assert_eq!(entry_ids(&hidden), [unread_id]);
```

- [ ] **Step 2: Run the backend test RED**

Run the exact focused test, for example:

```bash
cargo test --test feeds_http_test list_entries_defaults_to_all -- --exact
```

Expected: FAIL because `list_entries` currently uses `EntryViewDto::Unread` when the query omits `view`.

- [ ] **Step 3: Change the backend default only**

In `src/api/feeds.rs`, preserve explicit values and change the fallback:

```rust
let view = query.view.unwrap_or(EntryViewDto::All);
```

Do not change `src/feeds/store.rs`; it already implements `All` without a read predicate, `Unread` with `read_at IS NULL`, and `Saved` with `bookmarked`.

- [ ] **Step 4: Run the focused backend tests GREEN**

Run the new HTTP test and the existing store filter tests:

```bash
cargo test --test feeds_http_test list_entries_defaults_to_all -- --exact
cargo test feeds::store::tests::list_entries --lib
```

Expected: PASS; if the second command names no exact test, run the narrow `feeds::store::tests` module instead.

- [ ] **Step 5: Add failing route and Atrium tests**

Update/add tests that first express the new contract:

```ts
expect(Route.options.validateSearch?.({})).toMatchObject({ view: "all" });
expect(screen.getByRole("button", { name: /hide read/i })).toHaveAttribute(
  "aria-pressed",
  "false",
);
```

For `FeedRiverPanel`, assert its initial `FeedRiver` receives `data-view="all"`; activating Hide read changes it to `unread`; activating it again returns to `all`. Keep a separate Saved action.

In `FeedRiver.test.tsx`, render `view: "all"`, mark an entry read, and assert it remains rendered. Re-render with `view: "unread"` and assert the same cache projection excludes it.

- [ ] **Step 6: Run the UI tests RED**

```bash
bun run test src/routes/-feeds.test.tsx src/components/codex/FeedRiverPanel.test.tsx src/components/codex/FeedRiver.test.tsx src/api/feeds.test.ts
```

Expected: route and panel default assertions fail with `unread`; existing cache behavior remains green.

- [ ] **Step 7: Implement the minimal UI control contract**

In `Route.validateSearch`, accept all three valid wire values and default unknown/absent values to `all`:

```ts
view:
  search.view === "unread" || search.view === "saved"
    ? search.view
    : "all",
```

Replace raw wire-token labels with explicit actions. Preserve `view` in route search state:

```tsx
<Button
  aria-pressed={search.view === "unread"}
  onPress={() =>
    updateSearch({ view: search.view === "unread" ? "all" : "unread" })
  }
>
  Hide read
</Button>
<Button
  aria-pressed={search.view === "saved"}
  onPress={() => updateSearch({ view: search.view === "saved" ? "all" : "saved" })}
>
  Saved
</Button>
```

Use the same state transition in `FeedRiverPanel`, initialized with:

```ts
const [view, setView] = useState<EntryView>("all");
```

Keep Mark all read behavior conditional on `view === "unread"` unless an existing all-view action is already explicitly covered.

- [ ] **Step 8: Run focused RSS tests GREEN**

```bash
bun run test src/routes/-feeds.test.tsx src/components/codex/FeedRiverPanel.test.tsx src/components/codex/FeedRiver.test.tsx src/api/feeds.test.ts
```

Expected: PASS, including cache pagination/pageParams preservation.

- [ ] **Step 9: Commit**

```bash
git add src/api/feeds.rs tests ui/src/routes/feeds.tsx ui/src/components/codex/FeedRiverPanel.tsx ui/src/components/codex/FeedRiver.tsx ui/src/routes/-feeds.test.tsx ui/src/components/codex/FeedRiverPanel.test.tsx ui/src/components/codex/FeedRiver.test.tsx ui/src/api/feeds.test.ts
git commit -m "fix(feeds): keep read entries visible by default"
```

Stage only files actually changed.

---

### Task 2: Publish normative MCP LLM authoring rules

**Files:**
- Modify: `src/mcp/server.rs` (`CreatePageParams` docs, tool descriptions, `ServerHandler::get_info`, tests)
- Modify: `ui/src/docs/content/mcp.mdx`
- Modify: `.claude/skills/vault/SKILL.md`

**Interfaces:**
- Add a private `const MCP_INSTRUCTIONS: &str` in `src/mcp/server.rs`; `get_info()` assigns `Some(MCP_INSTRUCTIONS.to_string())`.
- Preserve all MCP tool names, schemas, arguments, and HTTP behavior.
- The policy is instructional, not server-side authorship detection or validation.

- [ ] **Step 1: Add failing instruction contract test**

Extract the current instruction literal into the planned constant only after the test is red. First add a `get_info` test which normalizes the returned string and asserts all normative clauses:

```rust
#[test]
fn server_instructions_define_llm_page_authoring_policy() {
    let info = test_server().get_info();
    let text = info.instructions.expect("instructions").to_lowercase();
    for required in [
        "search before creating",
        "ai-generated",
        "standalone page",
        "journal capture",
        "conversation capture",
        "assign",
        "project",
        "wikilink",
    ] {
        assert!(text.contains(required), "missing instruction: {required}");
    }
}
```

Add exact semantic assertions that standalone LLM-authored pages **must** use `ai-generated`, while edits, journal captures, and conversation captures do not acquire it merely because an LLM performed them.

- [ ] **Step 2: Run the MCP test RED**

```bash
cargo test mcp::server::tests::server_instructions_define_llm_page_authoring_policy --lib -- --exact
```

Expected: FAIL because current instructions omit the provenance and project-documentation rules.

- [ ] **Step 3: Centralize and expand authoritative instructions**

Define one constant adjacent to `KIND_TOKENS` and consume it from `get_info`. Its content must state, without optional language:

```text
Before creating a page, search for an existing page and extend it instead of duplicating it. Every standalone page authored by an LLM must include the `ai-generated` tag. Do not add that tag merely for an edit, a journal capture, or a conversation capture. Declare the page's real kind and project; use vault_assign to refile existing pages rather than inventing folders. Substantial project documentation must wikilink its project or hub page. Use vault_journal_capture and vault_capture_conversation for those dedicated intents instead of vault_create_page.
```

Retain the existing conflict, move/delete preview, and page-path guidance.

Update `CreatePageParams.tags` and the `vault_create_page` tool description to point cooperating LLM clients to the mandatory provenance rule. Update journal/capture descriptions to state the exclusion. Update `vault_assign` description for project filing. Do not add an automatic tag or reject requests.

- [ ] **Step 4: Mirror the policy in user and repository guidance**

Add an **LLM-authored pages** section to `ui/src/docs/content/mcp.mdx` with a compact decision table:

| Action | `ai-generated` | Tool |
| --- | --- | --- |
| Author standalone page | required | `vault_create_page` |
| Edit/append existing page | unchanged | `vault_edit_page` / `vault_append_page` |
| Journal capture | not added for authorship alone | `vault_journal_capture` |
| Conversation capture | not added for authorship alone | `vault_capture_conversation` |

State search-before-create, real Kind, project assignment, and project/hub wikilinking. Mirror the same rules in `.claude/skills/vault/SKILL.md` under Create/Capture without changing its other safety workflows.

- [ ] **Step 5: Run MCP and docs-focused verification GREEN**

```bash
cargo test mcp::server::tests --lib
bun run typecheck
bun run lint src/docs/content/mcp.mdx
```

Expected: MCP tests and UI static checks pass. If Biome does not lint MDX directly, run the repository UI lint command and report that limitation rather than inventing a file-specific success.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.rs ui/src/docs/content/mcp.mdx .claude/skills/vault/SKILL.md
git commit -m "docs(mcp): define LLM page authoring policy"
```

---

### Task 3: Review and focused smoke verification

**Files:**
- Modify only files required by review findings.

- [ ] **Step 1: Review RSS behavior**

Confirm default-all behavior exists in backend, full reader, and Atrium; Hide read is a filter rather than a mutation; Saved remains reachable; and route/cache keys still distinguish filters.

- [ ] **Step 2: Review MCP consistency**

Compare `MCP_INSTRUCTIONS`, relevant tool descriptions, `mcp.mdx`, and the vault skill. Resolve contradictions in the authoritative source first, then mirror them.

- [ ] **Step 3: Smoke both paths**

Run the app with a feed containing a read and unread entry. Confirm both appear initially, marking one read does not remove it, Hide read removes it, and clearing Hide read restores it. Start `clep mcp`, inspect `ServerInfo.instructions`, and verify all policy clauses are present.

- [ ] **Step 4: Commit review corrections**

Commit only if review or smoke verification required changes, with a message naming the corrected behavior.
