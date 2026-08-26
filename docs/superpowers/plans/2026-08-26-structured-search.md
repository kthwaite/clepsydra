# Structured and Composable Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one boolean structured-search language for the command palette, HTTP search endpoint, and MCP `vault_search` tool.

**Architecture:** A private Rust search subsystem owns source-spanned parsing and parameterized SQLite execution. `Index::search` delegates to it, the HTTP route maps typed parse errors to structured 400 responses, and existing clients send raw queries unchanged. The command palette only distinguishes non-retryable syntax errors from retryable transport/server failures.

**Tech Stack:** Rust 2024, rusqlite/SQLite FTS5, Axum, thiserror, React 19, TypeScript, TanStack Query, Vitest, Testing Library, MDX.

**Spec:** `docs/superpowers/specs/2026-08-26-structured-search-design.md`

## Global Constraints

- Preserve ordinary safe prefix full-text search; never expose authored input as raw FTS5 syntax.
- Supported fields are exactly lowercase `kind`, `tag`, and `project`.
- Kind values canonicalize through `Kind::from_token`; tag and project values match stored values exactly.
- Grammar is quoted phrases/values, whitespace AND, `|` OR, prefix `-` NOT, and parentheses with precedence `NOT > AND > OR`.
- Valid metadata-only and negative-only expressions are supported.
- Invalid structured syntax returns HTTP 400 with `detail.code = "invalid_search_query"` and `{ start, end }` byte span.
- Keep `SearchResult` and `SearchResultEntry` wire fields unchanged; metadata-only matches use `snippet: ""`.
- Do not extend or reuse the persisted Base `Filter` AST.
- Do not add dependencies, comparison fields, saved-search embeds, tag renaming, or an inline palette help panel.
- Every implementation task uses red-green TDD and ends in an independently reviewable commit.

## File Structure

- Create `src/vault/search/mod.rs` — narrow subsystem seam: `SearchQueryError`, `SearchDiagnostic`, `search(connection, input, limit)`.
- Create `src/vault/search/query.rs` — source-spanned lexer/parser, private AST, field/value validation, safe FTS term generation.
- Create `src/vault/search/sql.rs` — compile the validated AST to parameterized SQL; execute ordering, ranking, snippets, and limits.
- Modify `src/vault/mod.rs` — register the private `search` module.
- Modify `src/vault/index.rs` — add typed `IndexError::SearchQuery`, remove inline `fts_prefix_query`/`search_fts` API-search implementation, delegate `Index::search`.
- Modify `src/api/index_routes.rs` — map search-query errors to structured 400 responses.
- Modify `tests/api_test.rs` — cover successful structured HTTP search and error payloads.
- Modify `src/mcp/server.rs` — cover shared structured MCP semantics and invalid query reporting.
- Modify `ui/src/api/error.ts` — add a narrow `isInvalidSearchQuery` detail guard.
- Modify `ui/src/components/codex/CommandPalette.tsx` — placeholder guidance and non-retryable syntax errors.
- Modify `ui/src/components/codex/__tests__/CommandPalette.test.tsx` — protect palette behavior.
- Modify `ui/src/docs/content/links-search-graph-and-repair.mdx` — document the grammar and shared consumers.

---

### Task 1: Source-Spanned Search Query Parser

**Files:**
- Create: `src/vault/search/mod.rs`
- Create: `src/vault/search/query.rs`
- Modify: `src/vault/mod.rs`

**Interfaces:**
- Consumes: `crate::vault::kind::Kind::from_token(&str) -> Option<Kind>` and `Kind::as_str()`.
- Produces: `query::parse(input: &str) -> Result<SearchExpr, SearchQueryError>` for Task 2.
- Produces: `SearchQueryError { diagnostic: SearchDiagnostic }`, where `SearchDiagnostic` exposes `message: String`, `kind: SearchDiagnosticKind`, `span: SearchSpan`, and `column: usize` to Task 3.
- Produces: private `SearchExpr::{Text, Field, All, Any, Not}`, `TextMode::{Prefix, Phrase}`, `SearchField::{Kind, Tag, Project}`, and `SearchSpan { start, end }` for SQL compilation.

- [ ] **Step 1: Register the private module and write parser tests first**

Add `mod search;` beside `pub mod index;` in `src/vault/mod.rs`. In `src/vault/search/query.rs`, add a `#[cfg(test)] mod tests` that calls `parse` before its production body is written and asserts exact ASTs for:

```rust
parse("clep")
// Text { value: "clep", mode: Prefix, span: 0..4 }

parse("\"local backup\"")
// Text { value: "local backup", mode: Phrase, span: 0..14 }

parse("kind:Recipe tag:dinner")
// All([Field(Kind, "RECIPE"), Field(Tag, "dinner")])

parse("(tag:beer | tag:wine) tasting")
// All([Any([Field(Tag, "beer"), Field(Tag, "wine")]), Text("tasting")])

parse("kind:recipe -project:archive | tag:urgent")
// Any([All([Field(Kind, "RECIPE"), Not(Field(Project, "archive"))]), Field(Tag, "urgent")])
```

Also assert:

- `NOT > AND > OR` precedence;
- nested parentheses;
- `project:"My Project"` and escaped quote/backslash values;
- `ice-cream` is one text term while `-ice` is NOT;
- non-ASCII input reports byte spans and one-based Unicode columns separately;
- each required malformed case returns the expected `SearchDiagnosticKind`, exact byte span, and message fragment;
- `Kind:recipe` is an unknown field because field keywords are lowercase;
- `kind:not-a-kind` is an `UnknownKind` diagnostic;
- `tag:""` and `""` are empty-value diagnostics.

- [ ] **Step 2: Run parser tests and confirm the red state**

Run:

```bash
cargo test vault::search::query::tests --lib
```

Expected: compile failure because the parser types/functions do not exist yet.

- [ ] **Step 3: Implement the token model and lexer**

Implement source-spanned tokens for word, quoted value, colon, pipe, minus, left parenthesis, and right parenthesis. The lexer must:

- advance on UTF-8 character boundaries;
- retain byte `start..end` spans;
- unescape only `\"` and `\\` inside quotes;
- reject unterminated quotes at the opening quote span through end-of-input;
- treat `-` inside a word as content and at expression start as NOT;
- preserve colon/operator characters only through quoted input.

Use a concrete diagnostic enum:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchDiagnosticKind {
    UnknownField,
    MissingFieldValue,
    UnknownKind,
    UnmatchedQuote,
    UnexpectedParenthesis,
    UnmatchedParenthesis,
    DanglingOr,
    DanglingNot,
    EmptyGroup,
    EmptyValue,
    UnexpectedColon,
    ExpectedExpression,
}
```

`SearchQueryError::new(input, kind, span, message)` computes `column` as `input[..span.start].chars().count() + 1` and formats the public message with `at column {column}` exactly once.

- [ ] **Step 4: Implement the precedence parser and validation**

Implement recursive-descent functions equivalent to:

```rust
parse_or     := parse_and ("|" parse_and)*
parse_and    := parse_unary (parse_unary)*
parse_unary  := "-" parse_unary | parse_primary
parse_primary:= "(" parse_or ")" | field | text
field        := WORD ":" (WORD | QUOTED)
text         := WORD | QUOTED
```

Before treating `WORD ':'` as a field, map only `kind`, `tag`, and `project`. Unknown names return `UnknownField`; never reinterpret them as text. Canonicalize Kind values at parse time. Flatten adjacent `All` and `Any` children while preserving order and the outer span.

Expose only `pub(super)` parser/AST items needed by `sql.rs`. Re-export only the error/diagnostic types needed outside the subsystem from `search/mod.rs`.

- [ ] **Step 5: Run parser tests to green**

Run:

```bash
cargo test vault::search::query::tests --lib
```

Expected: all parser and diagnostic tests pass.

- [ ] **Step 6: Commit the parser**

```bash
git add src/vault/mod.rs src/vault/search/mod.rs src/vault/search/query.rs
git commit -m "feat: parse structured search expressions"
```

---

### Task 2: Correct SQLite Search Execution

**Files:**
- Create: `src/vault/search/sql.rs`
- Modify: `src/vault/search/mod.rs`
- Modify: `src/vault/index.rs`
- Test: `src/vault/index.rs` search test module
- Test: `tests/index_test.rs`
- Test: `tests/index_handle_test.rs`

**Interfaces:**
- Consumes: Task 1 `query::parse`, `SearchExpr`, `TextMode`, `SearchField`, and `SearchQueryError`.
- Produces: `search::search(conn: &rusqlite::Connection, input: &str, limit: usize) -> Result<Vec<SearchResult>, SearchExecutionError>`.
- Produces: `SearchExecutionError::{Query(SearchQueryError), Sqlite(rusqlite::Error)}` and conversion to `IndexError`.
- Preserves: `Index::search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>, IndexError>` and `IndexHandle::search(String, usize)` signatures.

- [ ] **Step 1: Expand real-index tests before implementation**

Replace the small `search_index()` fixture with pages carrying explicit IDs, titles, bodies, Kind, project, tags, computed Kind tags, and controlled `updated_at` values. Add focused tests that assert:

```rust
assert_paths(index.search("clep", 20).unwrap(), &["notes/clepsydra.md", "notes/stray.md"]);
assert_paths(index.search("\"local backup\"", 20).unwrap(), &["notes/backup.md"]);
assert_paths(index.search("kind:recipe", 20).unwrap(), &["recipes/beer.md", "recipes/wine.md"]);
assert_paths(index.search("tag:fermentation", 20).unwrap(), &["recipes/beer.md"]);
assert_paths(index.search("tag:recipe", 20).unwrap(), &["recipes/beer.md", "recipes/wine.md"]); // computed tag
assert_paths(index.search("project:Kitchen", 20).unwrap(), &["recipes/beer.md"]);
assert!(index.search("project:kitchen", 20).unwrap().is_empty());
assert_paths(index.search("(tag:beer | tag:wine) tasting", 20).unwrap(), expected);
assert_paths(index.search("-project:Archive", 20).unwrap(), expected);
```

Add ordering/snippet assertions:

- text-bearing matches precede metadata-only matches in `tasting | tag:reference`;
- text matches are ordered by best FTS rank;
- `kind:recipe` orders by `updated_at DESC`, missing timestamps last, then case-insensitive path and ID;
- metadata-only rows have `snippet == ""`;
- a row admitted through a metadata OR branch has an empty snippet unless a positive text leaf also matches it;
- `limit = 1` applies after boolean filtering and final ordering;
- negative-only queries return indexed pages without loading all candidates into Rust.

Update the old punctuation test: ordinary punctuation remains inert inside quoted text, while an unexpected unquoted colon now returns `IndexError::SearchQuery`.

- [ ] **Step 2: Run index tests and confirm the red state**

Run:

```bash
cargo test vault::index::tests::search --lib
cargo test --test index_test fts_search
cargo test --test index_handle_test search_
```

Expected: new structured-search assertions fail; existing plain-text assertions continue to compile.

- [ ] **Step 3: Implement safe text-leaf generation**

In `query.rs` or `sql.rs`, convert validated text leaves to safe FTS strings:

```rust
TextMode::Prefix => tokenized_terms
    .map(|term| format!("\"{}\"*", escape_fts_phrase(term)))
    .join(" AND "),
TextMode::Phrase => format!("\"{}\"", escape_fts_phrase(value)),
```

Do not pass authored `OR`, `NOT`, `*`, quotes, or parentheses as FTS operators. A text leaf whose tokenization produces no searchable token returns a query diagnostic rather than broadening to every page.

- [ ] **Step 4: Compile the boolean AST to parameterized SQL**

In `sql.rs`, build one statement with bound values only. Assign each positive text leaf a stable internal alias/ordinal. Compile:

- text leaf membership through an FTS page-ID subquery;
- Kind through `p.kind = ?`;
- Project through `p.project = ?`;
- Tag through `EXISTS (SELECT 1 FROM tags ... WHERE page_id = p.id AND tag = ?)`;
- `All`, `Any`, and `Not` through fully parenthesized SQL.

Track negation depth so only text leaves under an even number of `Not` nodes contribute ranking/snippets. Compute each result's best matching positive-text rank and corresponding snippet in SQL. Use the complete boolean condition before `ORDER BY` and `LIMIT`.

Required ordering expression:

```text
positive_text_match DESC,
best_rank ASC,
CASE WHEN positive_text_match THEN NULL ELSE p.updated_at END DESC NULLS LAST,
p.path COLLATE NOCASE ASC,
p.id ASC
```

If SQLite's accepted syntax does not support `NULLS LAST` in the bundled version, express it with `p.updated_at IS NULL` before descending timestamp. Return `snippet: ""` when no positive text leaf matches.

- [ ] **Step 5: Delegate `Index::search` and preserve the public boundary**

In `search/mod.rs`, expose the narrow executor. In `index.rs`:

- add `IndexError::SearchQuery(#[from] SearchQueryError)`;
- keep SQLite failures as `IndexError::Sqlite`;
- delegate `Index::search` to the search subsystem;
- remove the old API-only `fts_prefix_query` implementation after every caller migrates;
- retain `search_fts` only if a verified CLI caller still requires raw prepared FTS semantics; do not route structured API input through it.

Use LSP references on `search_fts` before removing or narrowing it.

- [ ] **Step 6: Run focused search tests to green**

Run:

```bash
cargo test vault::search --lib
cargo test vault::index::tests::search --lib
cargo test --test index_test fts_search
cargo test --test index_handle_test search_
```

Expected: all parser, index, and handle search tests pass.

- [ ] **Step 7: Commit index execution**

```bash
git add src/vault/search src/vault/index.rs tests/index_test.rs tests/index_handle_test.rs
git commit -m "feat: execute composable vault searches"
```

---

### Task 3: Shared HTTP and MCP Error Contract

**Files:**
- Modify: `src/api/index_routes.rs`
- Modify: `tests/api_test.rs`
- Modify: `src/mcp/server.rs`

**Interfaces:**
- Consumes: Task 2 `IndexError::SearchQuery(SearchQueryError)` and `SearchDiagnostic` fields.
- Produces: HTTP 400 `ApiError` with `error` and `detail = { code: "invalid_search_query", span: { start, end }, kind }`.
- Preserves: `GET /api/vault/index/search?q=...&limit=...` and MCP `SearchParams { query, limit }` request shapes.

- [ ] **Step 1: Write failing HTTP contract tests**

Extend `search_pages` or split it into focused tests. Seed pages with explicit metadata and assert URL-encoded queries:

```text
/api/vault/index/search?q=kind%3ARECIPE
/api/vault/index/search?q=%28tag%3Abeer+%7C+tag%3Awine%29+tasting
```

Assert exact successful paths. Add invalid cases for `knd:recipe`, `kind:unknown`, unmatched `(`, and dangling `|`. For `knd:recipe`, assert:

```json
{
  "status": 400,
  "error": "unknown search field 'knd' at column 1",
  "detail": {
    "code": "invalid_search_query",
    "span": { "start": 0, "end": 3 },
    "kind": "unknown_field"
  }
}
```

Retain the missing-`q` 400 assertion and a plain-text compatibility assertion.

- [ ] **Step 2: Write failing MCP shared-semantics tests**

In the seeded MCP fixture, give `notes/alpha.md` and at least one peer distinct Kind/tag/project metadata. Add:

- `vault_search(query: "kind:note tag:research")` returns only the matching page;
- grouped boolean syntax returns the same path set as HTTP;
- `vault_search(query: "knd:note")` returns an error string containing the public parser message and does not return an empty result array.

- [ ] **Step 3: Run boundary tests and confirm the red state**

Run:

```bash
cargo test --test api_test search_
cargo test mcp::server::tests::search_ --lib
```

Expected: structured successful queries may work after Task 2; invalid queries still surface as internal errors until route mapping is added.

- [ ] **Step 4: Map only typed query failures to HTTP 400**

In `src/api/index_routes.rs`, replace the blanket internal mapping with an explicit match:

```rust
match state.index.search(q, limit).await {
    Ok(results) => results,
    Err(IndexError::SearchQuery(error)) => {
        let diagnostic = error.diagnostic();
        return Err(ApiError::bad_request_with_detail(
            diagnostic.message.clone(),
            serde_json::json!({
                "code": "invalid_search_query",
                "span": {
                    "start": diagnostic.span.start,
                    "end": diagnostic.span.end,
                },
                "kind": diagnostic.kind.as_str(),
            }),
        ));
    }
    Err(error) => return Err(ApiError::internal(format!("search failed: {error}"))),
}
```

Keep SQLite/IO failures as 500. Do not make every `IndexError::Other` a client error.

- [ ] **Step 5: Run boundary tests to green**

Run:

```bash
cargo test --test api_test search_
cargo test mcp::server::tests::search_ --lib
```

Expected: HTTP success/error payloads and MCP shared behavior pass.

- [ ] **Step 6: Commit API and MCP behavior**

```bash
git add src/api/index_routes.rs tests/api_test.rs src/mcp/server.rs
git commit -m "feat: expose structured search through HTTP and MCP"
```

---

### Task 4: Command-Palette Guidance and User Documentation

**Files:**
- Modify: `ui/src/api/error.ts`
- Modify: `ui/src/components/codex/CommandPalette.tsx`
- Modify: `ui/src/components/codex/__tests__/CommandPalette.test.tsx`
- Modify: `ui/src/docs/content/links-search-graph-and-repair.mdx`

**Interfaces:**
- Consumes: Task 3 API error shape with unknown `detail` in generated OpenAPI types.
- Produces: `isInvalidSearchQuery(error: unknown): boolean` in `ui/src/api/error.ts`.
- Preserves: `useSearch(query, limit)` sends the raw query and existing stale-response protection.

- [ ] **Step 1: Write failing UI tests**

Extend the existing hoisted `useSearchMock` cases:

1. Assert the command-query input placeholder equals `Search pages · kind:recipe (tag:beer | tag:wine)`.
2. Type `kind:recipe` and assert `useSearchMock` receives that exact raw string with limit 12 after debounce.
3. Return this error for the current query:

```ts
{
  status: 400,
  error: "unknown search field 'knd' at column 1",
  detail: {
    code: "invalid_search_query",
    span: { start: 0, end: 3 },
    kind: "unknown_field",
  },
}
```

Assert the alert contains the message and no button named `Retry search` exists.
4. Retain/assert that a 500 or ordinary `Error("Search service unavailable")` shows `Retry search` and invokes `refetch`.
5. Retain stale-query tests: an old syntax error must not replace the loading/results state for the current query.

- [ ] **Step 2: Run the palette test and confirm the red state**

Run:

```bash
bun run --cwd ui test -- src/components/codex/__tests__/CommandPalette.test.tsx
```

Expected: placeholder and Retry-visibility assertions fail.

- [ ] **Step 3: Add the narrow error guard**

In `ui/src/api/error.ts`, validate unknown detail without casting blindly:

```ts
export function isInvalidSearchQuery(error: unknown): boolean {
  if (!isApiError(error) || typeof error.detail !== "object" || error.detail === null) {
    return false;
  }
  return "code" in error.detail && error.detail.code === "invalid_search_query";
}
```

Do not generalize this into a registry or change `formatApiError`.

- [ ] **Step 4: Update command-palette rendering**

Import `isInvalidSearchQuery`. Derive `searchSyntaxError = showSearchError && isInvalidSearchQuery(searchError)`. Change the placeholder to the approved example. Render the existing alert message for every current error, but render the Retry button only when `!searchSyntaxError`.

Do not parse in TypeScript, change debouncing, alter local command matching, or change note result mapping.

- [ ] **Step 5: Document the complete grammar**

Replace/expand the existing `## Full-text search` section in `links-search-graph-and-repair.mdx`. Include:

```text
kind:recipe
kind:recipe tag:dinner
(tag:beer | tag:wine) tasting
-project:Archive
project:"My Project"
"local backup"
```

State the three fields, exact tag/project semantics, Kind normalization, operators, precedence, quoting/escaping, metadata-only ordering, empty snippets/path fallback, protected-page behavior, shared HTTP/MCP syntax, and 400 behavior for invalid syntax. Keep the distinction from wikilink and block search.

- [ ] **Step 6: Run focused UI tests and docs build**

Run:

```bash
bun run --cwd ui test -- src/components/codex/__tests__/CommandPalette.test.tsx
bun run --cwd ui typecheck
bun run --cwd ui build
```

Expected: palette tests, TypeScript, MDX compilation, and production build pass.

- [ ] **Step 7: Commit UI and documentation**

```bash
git add ui/src/api/error.ts ui/src/components/codex/CommandPalette.tsx ui/src/components/codex/__tests__/CommandPalette.test.tsx ui/src/docs/content/links-search-graph-and-repair.mdx
git commit -m "feat: surface structured search in the command palette"
```

---

### Task 5: Runtime Proof and Completion Gates

**Files:**
- Modify only if a verified defect is found; do not add smoke-test scaffolding.

**Interfaces:**
- Consumes: complete Tasks 1–4 behavior.
- Produces: runtime evidence and clean verification output for merge.

- [ ] **Step 1: Run Rust formatting and focused regression tests**

Run:

```bash
cargo fmt --check
cargo test vault::search --lib
cargo test vault::index::tests::search --lib
cargo test --test index_test fts_search
cargo test --test index_handle_test search_
cargo test --test api_test search_
cargo test mcp::server::tests::search_ --lib
```

Expected: all pass. Fix source failures, then rerun only failed focused commands before continuing.

- [ ] **Step 2: Run the actual server and browser smoke path**

Start the server through the harness process manager with the worktree as `cwd`, wait for its ready log/port, and open the command palette in Chromium. Against a seeded disposable vault, exercise:

- plain prefix text;
- `kind:note` metadata-only search;
- `(tag:beer | tag:wine) tasting`;
- `-project:Archive`;
- `knd:note` syntax error.

Observe result paths/order, non-empty snippets for positive text matches, path fallback for empty metadata snippets, keyboard selection/opening, the approved placeholder, and no Retry button for the syntax error. Stop the managed server afterward.

- [ ] **Step 3: Run mandatory complete verification gates**

Run exactly:

```bash
cargo test
cargo clippy --all-targets --all-features -- -D warnings
bun run --cwd ui typecheck
bun run --cwd ui lint
bun run --cwd ui test
```

Expected: every command exits 0. These are the project-required test, Rust lint, UI typecheck, UI lint, and UI test-suite gates.

- [ ] **Step 4: Check the implementation diff for clean cutover**

Confirm:

- no old API-search parser remains beside the new subsystem;
- no client-side parser or compatibility alias exists;
- every `Index::search` caller compiles against the unchanged public signature;
- docs and tests match exact wire behavior (`snippet: ""` for metadata-only);
- no debug output, ignored tests, temporary fixtures, or uncommitted generated files remain.

- [ ] **Step 5: Commit only verified fixes, if any**

If runtime or full-gate fixes changed tracked files, review those changes and commit them:

```bash
git add -u
git commit -m "fix: complete structured search verification"
```

If no files changed, do not create an empty commit.
