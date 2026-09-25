# Stone & Lamp Phase 4.4b — Unlinked Mentions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show "Unlinked mentions" in the Folio right rail: pages whose body names this page (title or alias) without linking to it.

**Architecture:** A new read-only index query in `clep-index` (`VaultIndex::unlinked_mentions`) uses FTS5 to find candidate pages, then verifies each candidate with an exact, case-insensitive, whole-phrase scan of `page_bodies`. `clep-api` exposes it as `GET /api/vault/index/unlinked/{*path}`. The UI adds a `useUnlinkedMentions` hook and a `faint`-tick section in the right rail, styled like "Linked from".

**Tech Stack:** Rust (rusqlite + FTS5, Axum 0.8, utoipa), React 19, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` §5.6 Folio ("Unlinked mentions" gets a `faint` tick). Builds on phase 4.4a (`docs/superpowers/plans/2026-09-25-stone-and-lamp-phase-4-4a-folio.md`).

## User rulings (2026-09-25)

- A mention = the page's **title or any alias** appears in another page's body as a whole phrase, case-insensitive, and that page has **no link** to this page. The page itself is excluded. Terms shorter than 3 characters are ignored.
- **Open only:** each entry is the source's serif title plus a snippet with the mention highlighted; clicking opens that page. No vault writes, no "Link" action.

## Global Constraints

- Read-only: the endpoint never mutates the vault or index.
- Encrypted pages are never sources (their indexed body is ciphertext) and an encrypted target returns an empty list.
- A title falls back to the file stem when the page has no `title`.
- Rail styling follows 4.4a: `Section compact pip="dim"`, serif 21px titles, `highlightMatch` + `plainWikiText` snippets, text nodes only.
- After changing the route/DTO, regenerate `ui/src/api/schema.d.ts` offline: `cargo run -q -p clep-api --example openapi > target/openapi.json && (cd ui && bun run openapi:file)`.

## Review Focus

1. Porter stemming: FTS finds "Alphas" for "Alpha"; the exact whole-phrase scan must drop it.
2. Word boundaries with Unicode (é, CJK) and punctuation: "Alpha," and "(Alpha)" match; "Alphabet" does not.
3. A page that links via an alias (`[[Target|x]]`) or by path counts as linked and is excluded.
4. Snippet windows never split a UTF-8 character (slice on char boundaries).
5. Large vaults: candidate count is bounded (FTS `LIMIT`) and the result is capped (`limit`).

---

### Task 1: `VaultIndex::unlinked_mentions`

**Files:** Modify `crates/clep-index/src/index.rs` (struct `UnlinkedMention`, method), `crates/clep-index/src/index_handle.rs` (async wrapper); Test `crates/clep-index/tests/unlinked_mentions_test.rs` (create).

**Produces:**
```rust
pub struct UnlinkedMention {
    pub source_id: String,
    pub source_path: String,
    pub source_title: Option<String>,
    /// The title or alias as written in the source body.
    pub matched: String,
    /// Plain-text window around the first mention (≤ ~160 chars, "…" at cut ends).
    pub context: String,
}
impl VaultIndex { pub fn unlinked_mentions(&self, target: &VaultPath, limit: usize) -> Result<Vec<UnlinkedMention>, IndexError> }
impl IndexHandle { pub async fn unlinked_mentions(&self, vp: VaultPath, limit: usize) -> Result<Vec<UnlinkedMention>, IndexError> }
```

- [ ] RED (`unlinked_mentions_test.rs`, using the `setup_vault` + `build_handle` pattern from `index_handle_test.rs`): finds a title mention; finds an alias mention; case-insensitive; excludes a page linking `[[Target]]`, `[[Target|other text]]` and by path; excludes the target itself; rejects "Targetting"/"Targets" (porter) and "Alphabet" for "Alpha"; matches "Alpha," and "(Alpha)"; ignores 2-character aliases; excludes encrypted sources; context contains the matched text; returns empty for an unknown path; respects `limit`; results ordered by source title then path.
- [ ] Implement: look up target (`id`, `title`, `meta_json`, `encrypted`, path stem); terms = title-or-stem + `meta.aliases`, trimmed, deduped case-insensitively, `len ≥ 3` chars; linked source ids via the same predicate as `backlinks_with_context` (`target_id = id OR target_path = path OR target_canonical = canonical`); candidates = union over terms of `SELECT page_id FROM pages_fts WHERE pages_fts MATCH fts_quote(term) LIMIT 500`; drop self, linked, `encrypted = 1`; for each candidate read `page_bodies.body`, find the first case-insensitive occurrence of any term whose neighbours are not alphanumeric (char-aware), skipping occurrences inside `[[…]]`; build the context window on char boundaries, collapse whitespace; sort and truncate to `limit`.
- [ ] Run `cargo test -p clep-index --test unlinked_mentions_test`; `cargo clippy -p clep-index`.
- [ ] Commit `feat(index): unlinked mentions query`.

### Task 2: API route

**Files:** Modify `crates/clep-api/src/api/index_routes.rs` (DTO `UnlinkedMentionEntry`, handler `unlinked_mentions`, route `/unlinked/{*path}`), `crates/clep-api/src/api/openapi.rs` (register path + schema); Test `crates/clep-api/tests/api_test.rs`; regenerate `ui/src/api/schema.d.ts`; add `useUnlinkedMentions(path)` to `ui/src/api/index.ts` (`enabled: !!path, throwOnError: false`, same policy as `useBacklinks`).

- [ ] RED (`api_test.rs`): `unlinked_mentions_endpoint_lists_unlinked_pages` — Beta mentions "Alpha" without linking, Gamma links `[[Alpha]]`; GET `/api/vault/index/unlinked/alpha.md` returns exactly Beta with `matched` "Alpha" and a context containing it; `unlinked_mentions_endpoint_rejects_invalid_path` → 400.
- [ ] Implement with limit 50; utoipa doc like `backlinks`.
- [ ] Run `cargo test -p clep-api --test api_test unlinked`; regenerate the schema offline; `cd ui && bun run typecheck`.
- [ ] Commit `feat(api): unlinked mentions endpoint`.

### Task 3: Right-rail section

**Files:** Modify `ui/src/components/codex/Folio.tsx` (`relationships`); Tests `ui/src/components/codex/__tests__/Folio.test.tsx` (mock `useUnlinkedMentions` via a hoisted `unlinkedState`), and add `useUnlinkedMentions: () => ({ data: [] })` to every other test file that mocks `#/api/index` with a Folio render (find them with `rg -l 'useBacklinks' ui/src --glob '*test*'`).

- [ ] RED: right-rail headings are `["Linked from", "Unlinked mentions", "Links out", "Similar"]` when mentions exist; "Unlinked mentions" uses a `faint` tick (`[data-tick]` has `bg-faint`) and its caption shows the count; each entry is a link with a serif 21px `[data-link-title]` and a `[data-link-snippet]` whose `mark` holds `matched`; the section is absent when the list is empty.
- [ ] Implement, reusing the Linked-from entry markup (extract a `RailLinkEntry` component used by both sections).
- [ ] Run `cd ui && bun run test src/components/codex`.
- [ ] Commit `feat(ui): Folio unlinked mentions`.

### Task 4: Gates, smoke, docs, review, merge

- [ ] `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test -p clep-index -p clep-api`; UI suite, typecheck, lint.
- [ ] Smoke on the scratch vault (`CLEPSYDRA__VAULT__ROOT` set): a page mentioned by title in one page and by alias in another, linked from a third; the rail shows the two mentions, not the linker; bone and charcoal.
- [ ] Docs: `ui/src/docs/content/links-search-graph-and-repair.mdx` — define an unlinked mention and where it shows; `api-reference.mdx` — the new endpoint line.
- [ ] Final Opus review, fix pass, merge to develop, clean up, memory.
