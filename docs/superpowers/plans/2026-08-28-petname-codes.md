# Petname Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace sequential Task/Cycle codes (`TSK-0072`, `S-3`) with collision-free hybrid petname codes (`TSK-brave-finch-7q3zd`, `S-calm-heron-2xm9p`), add unique-prefix addressing, and ship the one-time vault migration — phase 2 of `clep sync`.

**Architecture:** A new `vault::code` module owns the format (frozen 512-word lists + 5-char lowercase Crockford32 tail), minting, and validation. Server minting replaces the per-machine `code_counters` counter with mint-and-re-roll against the index. Codes stay lowercase everywhere (the six `to_ascii_uppercase` sites become identity). Prefix resolution lives in one server helper (`resolve_code`) plus the MCP client's board lookup. `clep codes migrate` renames every legacy-coded TASK/CYCLE page through the existing move planner (wikilinks rewritten for free) and then rewrites plain-text legacy tokens across the vault with new machinery. UI drops its client-side `S-${n}` mint; Neovim loosens its `%d+` pattern.

**Tech Stack:** Rust 2024 (regex, rusqlite, existing xorshift RNG in `block_id.rs`), React/TS (Vitest), Lua (Neovim headless tests). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-clep-sync-design.md` §1; `docs/adr/0003-hybrid-petname-task-codes.md`; `CONTEXT.md` **Code** entry.

## Global Constraints

- Branch `feature/petname-codes` off develop `0f76f04a`; worktree `.worktrees/petname-codes` (already set up: `ui/dist` built, `cargo build` green).
- Rust is fmt-clean and CI-gated: run `cargo fmt` freely; every commit must pass `cargo fmt --check`. UI biome is NOT clean repo-wide: never run `biome check --write` across `ui/src`; confirm only that files you touch add no new lint errors.
- Code format, exact: `^(TSK|S)-[a-z]{3,6}-[a-z]{3,6}-[0-9a-hjkmnp-tv-z]{5}$`. Tail alphabet `CROCKFORD32 = b"0123456789abcdefghjkmnpqrstvwxyz"` (lowercase, no `i l o u`), `TAIL_LEN = 5`. Word lists are exactly 512 entries each, given verbatim in Appendix A/B — frozen; may grow later, never shrink or reorder.
- Codes are NEVER uppercased or otherwise normalized on read; the code IS the filename stem verbatim. User input is matched case-insensitively; what gets stored (paths, `cycle = "…"` frontmatter) is the canonical stem.
- Legacy-format regexes (`^TSK-\d{4}$`, `^S-\d+$`, and the prose token `\b(TSK-\d{4}|S-\d+)\b`) exist ONLY in the migration module `src/vault/recode.rs`. No other code recognizes legacy codes (clean break).
- New CLI subcommands need exact `## \`clep codes\`` / `## \`clep codes migrate\`` headings in `ui/src/docs/content/cli.mdx` (`tests/docs_cli_coverage_test.rs` enforces).
- Never pipe cargo through `tail`/`grep` when the exit code matters; run bare and read the end.
- Running the migration against the user's live vault is NOT part of this branch (done post-merge, server stopped, with explicit confirmation).
- Line numbers below were verified on develop `0f76f04a` in the worktree.

---

### Task 1: `vault::code` — format, word lists, minting, validation

**Files:**
- Create: `src/vault/code.rs`, `src/vault/wordlists/adjectives.txt`, `src/vault/wordlists/nouns.txt`
- Modify: `src/vault/mod.rs` (add `pub mod code;` in alphabetical position), `src/vault/block_id.rs` (add one `pub(crate)` helper next to `generate_short_id`, line 140)

**Interfaces:**
- Consumes: `block_id::next_random() -> u64` (private, line 101) via the new helper.
- Produces (all `pub` in `crate::vault::code`):

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeFamily { Task, Cycle }
impl CodeFamily {
    pub fn prefix(self) -> &'static str;          // "TSK-" | "S-"
    pub fn kind(self) -> crate::vault::kind::Kind; // Kind::Task | Kind::Cycle
    pub fn from_kind(kind: Kind) -> Option<Self>;
}
pub const TAIL_LEN: usize = 5;
pub const CROCKFORD32: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
pub fn adjectives() -> &'static [&'static str];   // 512, sorted, unique
pub fn nouns() -> &'static [&'static str];        // 512, sorted, unique
pub fn mint(family: CodeFamily) -> String;         // e.g. "TSK-brave-finch-7q3zd"
pub fn is_valid_code(s: &str) -> bool;             // full format only
pub fn family_of(code: &str) -> Option<CodeFamily>; // None unless is_valid_code
```
and in `block_id.rs`: `pub(crate) fn fill_random_crockford32(buf: &mut [u8])`.

- [ ] **Step 1: Write the word list files.** Create `src/vault/wordlists/adjectives.txt` and `nouns.txt` with EXACTLY the contents of Appendix A and Appendix B (one word per line, sorted ascending, trailing newline). Verify: `wc -l src/vault/wordlists/*.txt` → 512 each; `sort -c` passes on both.

- [ ] **Step 2: Write the failing tests** (in-module `#[cfg(test)]` in `code.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn word_ok(w: &str) -> bool {
        (3..=6).contains(&w.len()) && w.bytes().all(|b| b.is_ascii_lowercase())
    }

    #[test]
    fn word_lists_are_frozen_shape() {
        for list in [adjectives(), nouns()] {
            assert_eq!(list.len(), 512);
            assert!(list.iter().all(|w| word_ok(w)), "every word is 3-6 lowercase ascii letters");
            assert!(list.windows(2).all(|p| p[0] < p[1]), "sorted ascending, unique");
        }
        let adj: HashSet<&str> = adjectives().iter().copied().collect();
        assert!(nouns().iter().all(|n| !adj.contains(n)), "no word in both lists");
    }

    #[test]
    fn mint_matches_format_and_family_prefix() {
        let t = mint(CodeFamily::Task);
        let c = mint(CodeFamily::Cycle);
        assert!(t.starts_with("TSK-") && is_valid_code(&t), "{t}");
        assert!(c.starts_with("S-") && is_valid_code(&c), "{c}");
        assert_eq!(family_of(&t), Some(CodeFamily::Task));
        assert_eq!(family_of(&c), Some(CodeFamily::Cycle));
        let tail = t.rsplit('-').next().unwrap();
        assert_eq!(tail.len(), TAIL_LEN);
        assert!(tail.bytes().all(|b| CROCKFORD32.contains(&b)));
        let body: Vec<&str> = t["TSK-".len()..].split('-').collect();
        assert!(adjectives().contains(&body[0]) && nouns().contains(&body[1]));
    }

    #[test]
    fn mints_are_distinct() {
        let set: HashSet<String> = (0..2000).map(|_| mint(CodeFamily::Task)).collect();
        assert_eq!(set.len(), 2000);
    }

    #[test]
    fn validation_rejects_legacy_uppercase_and_bad_tails() {
        for bad in ["TSK-0072", "S-3", "TSK-BRAVE-FINCH-7Q3ZD", "tsk-brave-finch-7q3zd",
                    "TSK-brave-finch-7q3zi", "TSK-brave-finch-7q3z", "TSK-brave-7q3zd",
                    "TSK-brave-finch-7q3zd-extra", "", "TSK-"] {
            assert!(!is_valid_code(bad), "{bad}");
            assert_eq!(family_of(bad), None, "{bad}");
        }
        assert!(is_valid_code("TSK-brave-finch-7q3zd"));
        assert!(is_valid_code("S-calm-heron-2xm9p"));
    }

    #[test]
    fn family_kind_roundtrip() {
        use crate::vault::kind::Kind;
        assert_eq!(CodeFamily::Task.kind(), Kind::Task);
        assert_eq!(CodeFamily::from_kind(Kind::Cycle), Some(CodeFamily::Cycle));
        assert_eq!(CodeFamily::from_kind(Kind::Note), None);
    }
}
```

- [ ] **Step 3: Verify failure** — `cargo test --lib code::` → FAIL (module unresolved).

- [ ] **Step 4: Implement.** In `block_id.rs`, beside `generate_short_id` (line 140):

```rust
/// Lowercase Crockford base32 alphabet (no `i l o u`), used for the tail of
/// Task/Cycle codes (docs/adr/0003). Kept here so the RNG stays private.
pub(crate) const CROCKFORD32: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";

/// Fill `buf` with random lowercase Crockford base32 characters.
pub(crate) fn fill_random_crockford32(buf: &mut [u8]) {
    for slot in buf.iter_mut() {
        *slot = CROCKFORD32[(next_random() % 32) as usize];
    }
}
```

`src/vault/code.rs`:

```rust
//! Task and Cycle codes: `TSK-<adjective>-<noun>-<tail>` / `S-…`
//! (docs/adr/0003-hybrid-petname-task-codes.md). Two frozen 512-word lists
//! carry memorability; a 5-character lowercase Crockford base32 tail carries
//! the entropy (43 bits total). Codes are lowercase after the prefix because
//! they are filenames on a case-insensitive filesystem.

use std::sync::LazyLock;

use regex::Regex;

use super::block_id::fill_random_crockford32;
use super::kind::Kind;

pub const TAIL_LEN: usize = 5;
pub const CROCKFORD32: &[u8; 32] = super::block_id::CROCKFORD32;

static ADJECTIVES: LazyLock<Vec<&'static str>> =
    LazyLock::new(|| include_str!("wordlists/adjectives.txt").lines().collect());
static NOUNS: LazyLock<Vec<&'static str>> =
    LazyLock::new(|| include_str!("wordlists/nouns.txt").lines().collect());
static CODE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(TSK|S)-[a-z]{3,6}-[a-z]{3,6}-[0-9a-hjkmnp-tv-z]{5}$").expect("static regex")
});

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeFamily {
    Task,
    Cycle,
}

impl CodeFamily {
    pub fn prefix(self) -> &'static str {
        match self {
            CodeFamily::Task => "TSK-",
            CodeFamily::Cycle => "S-",
        }
    }

    pub fn kind(self) -> Kind {
        match self {
            CodeFamily::Task => Kind::Task,
            CodeFamily::Cycle => Kind::Cycle,
        }
    }

    pub fn from_kind(kind: Kind) -> Option<Self> {
        match kind {
            Kind::Task => Some(CodeFamily::Task),
            Kind::Cycle => Some(CodeFamily::Cycle),
            _ => None,
        }
    }
}

pub fn adjectives() -> &'static [&'static str] {
    &ADJECTIVES
}

pub fn nouns() -> &'static [&'static str] {
    &NOUNS
}

/// Mint a fresh code. Uniqueness against the vault is the caller's job
/// (re-roll on collision); this only guarantees the format.
pub fn mint(family: CodeFamily) -> String {
    let mut tail = [0u8; TAIL_LEN];
    fill_random_crockford32(&mut tail);
    let adj = ADJECTIVES[(word_index() as usize) % ADJECTIVES.len()];
    let noun = NOUNS[(word_index() as usize) % NOUNS.len()];
    format!(
        "{}{}-{}-{}",
        family.prefix(),
        adj,
        noun,
        std::str::from_utf8(&tail).expect("crockford32 is ascii")
    )
}

/// One uniformly random index in 0..512, drawn from the shared RNG.
fn word_index() -> u16 {
    let mut b = [0u8; 2];
    fill_random_crockford32(&mut b);
    // two base32 symbols = 10 bits; fold to 9 bits (512 words)
    let hi = CROCKFORD32.iter().position(|c| *c == b[0]).unwrap_or(0) as u16;
    let lo = CROCKFORD32.iter().position(|c| *c == b[1]).unwrap_or(0) as u16;
    ((hi << 5) | lo) & 0x1ff
}

pub fn is_valid_code(s: &str) -> bool {
    CODE_RE.is_match(s)
}

pub fn family_of(code: &str) -> Option<CodeFamily> {
    if !is_valid_code(code) {
        return None;
    }
    if code.starts_with("TSK-") {
        Some(CodeFamily::Task)
    } else {
        Some(CodeFamily::Cycle)
    }
}
```

Confirm the `regex` crate is already a dependency (`Cargo.toml` lists it).

- [ ] **Step 5: Verify pass** — `cargo test --lib code::` → 5 PASS; `cargo fmt --check` clean.
- [ ] **Step 6: Commit** — `git add src/vault/code.rs src/vault/wordlists src/vault/mod.rs src/vault/block_id.rs && git commit -m "feat(vault): hybrid petname code module with frozen word lists"`

---

### Task 2: Server minting via re-roll; codes are stems verbatim

**Files:**
- Modify: `src/api/board/mod.rs` (delete `max_code_number` :359-377 and `reserve_next_code_number` :381-395; add `code_stems` + `mint_unique_code`; generalize `cycle_stems` :323-332 onto `code_stems`)
- Modify: `src/api/board/tasks.rs:27` (import), `:70-71` (mint), `:314` (uppercase → identity)
- Modify: `src/api/board/cycles.rs:27` (import), `:68-88` (explicit code validation + mint)
- Modify: `src/api/board/read.rs:100,103,163,339,430` and `src/api/agenda.rs:595` (`to_ascii_uppercase()` → identity)
- Modify: `src/vault/index.rs:275-278` (drop `code_counters` DDL; add `DROP TABLE IF EXISTS code_counters;` to the schema batch so existing caches shed it), delete `reserve_code_number` :319-346
- Modify: `tests/index_test.rs:8` (import) and delete the two tests at :1811-1836
- Modify: `tests/api_board_test.rs` — assertions that expect sequential codes (see Step 1)

**Interfaces:**
- Consumes: `code::{mint, is_valid_code, CodeFamily}` (Task 1).
- Produces in `src/api/board/mod.rs`:

```rust
/// Filename stems of every page of `kind` — these ARE the codes.
pub(crate) fn code_stems(conn: &rusqlite::Connection, kind: Kind) -> Result<BTreeSet<String>, rusqlite::Error>;
/// Mint a code that no existing page of the family's kind uses (re-rolls on collision).
pub(crate) async fn mint_unique_code(state: &AppState, family: CodeFamily) -> Result<String, ApiError>;
```
`cycle_stems` becomes a one-line wrapper over `code_stems(conn, Kind::Cycle)` returning `Vec<String>` (keep its callers compiling), or its callers switch to the set — implementer's choice, no behavior change.

- [ ] **Step 1: Write the failing tests** (append to `tests/api_board_test.rs`, using its existing server fixture helper — read the top of the file for the create-task/create-cycle request idioms and reuse them verbatim):

```rust
#[tokio::test]
async fn created_task_gets_petname_code_used_verbatim_as_stem() {
    let (server, _tmp, _state) = setup_server();
    let resp = server.post("/api/vault/board/tasks")
        .json(&serde_json::json!({"title": "Alpha", "project": "clepsydra"}))
        .await;
    resp.assert_status_ok();
    let body: serde_json::Value = resp.json();
    let code = body["code"].as_str().unwrap().to_string();
    assert!(clepsydra::vault::code::is_valid_code(&code), "{code}");
    assert_eq!(body["path"].as_str().unwrap(), format!("tasks/clepsydra/{code}.md"));
    // lowercase body survives the round trip through the board listing
    let board: serde_json::Value = server.get("/api/vault/board").await.json();
    let listed = board["tasks"].as_array().unwrap().iter().find(|t| t["code"] == code);
    assert!(listed.is_some(), "board lists the exact lowercase code");
}

#[tokio::test]
async fn created_cycle_without_code_gets_petname_code() {
    let (server, _tmp, _state) = setup_server();
    let resp = server.post("/api/vault/board/cycles")
        .json(&serde_json::json!({"label": "Cycle one"}))
        .await;
    resp.assert_status_ok();
    let code = resp.json::<serde_json::Value>()["code"].as_str().unwrap().to_string();
    assert!(code.starts_with("S-") && clepsydra::vault::code::is_valid_code(&code), "{code}");
}

#[tokio::test]
async fn explicit_cycle_code_must_be_valid_format() {
    let (server, _tmp, _state) = setup_server();
    let bad = server.post("/api/vault/board/cycles")
        .json(&serde_json::json!({"label": "x", "code": "S-13"}))
        .await;
    bad.assert_status_bad_request();
    let good = server.post("/api/vault/board/cycles")
        .json(&serde_json::json!({"label": "x", "code": "S-calm-heron-2xm9p"}))
        .await;
    good.assert_status_ok();
    assert_eq!(good.json::<serde_json::Value>()["code"], "S-calm-heron-2xm9p");
}
```

Adapt the request paths/field names to what the file already uses (e.g. if cycles are created with `body.code` under a different route prefix, follow the file). Then REWRITE the existing sequential assertions: `:839-840` ("should allocate TSK-0482 after TSK-0481") → assert both created codes are `is_valid_code` and distinct; `:1865-1922` `concurrent_create_requests_reserve_unique_task_and_cycle_codes` → assert the two task codes are valid + distinct and the two cycle codes are valid + distinct (drop the `["TSK-0001","TSK-0002"]` / `["S-1","S-2"]` literals). Any other test that hardcodes a code it expects the SERVER to mint gets the same treatment; tests that merely seed fixture files with legacy stems (`tasks/TSK-0402.md`) stay untouched — stems are arbitrary strings on read.

- [ ] **Step 2: Verify failure** — `cargo test --test api_board_test petname` → FAIL (codes are `TSK-0001`; explicit `S-13` accepted).

- [ ] **Step 3: Implement.** `src/api/board/mod.rs`:

```rust
use std::collections::BTreeSet;
use crate::vault::code::{self, CodeFamily};

/// Filename stems of every page of `kind`. Task/Cycle stems ARE their codes.
pub(crate) fn code_stems(
    conn: &rusqlite::Connection,
    kind: Kind,
) -> Result<BTreeSet<String>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT path FROM pages WHERE kind = ?1")?;
    let stems = stmt
        .query_map(params![kind.as_str()], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .map(|p| path_stem(&p).to_string())
        .collect();
    Ok(stems)
}

/// Mint a code no existing page of the family's kind uses. With 43 bits of
/// entropy a collision is astronomically unlikely; the loop exists so the
/// guarantee is structural, not probabilistic.
pub(crate) async fn mint_unique_code(
    state: &AppState,
    family: CodeFamily,
) -> Result<String, ApiError> {
    const ATTEMPTS: usize = 8;
    let kind = family.kind();
    let stems = state
        .index
        .with_index(move |index, _vault| code_stems(index.connection(), kind))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;
    for _ in 0..ATTEMPTS {
        let candidate = code::mint(family);
        if !stems.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err(ApiError::internal(format!(
        "could not mint a unique {} code after {ATTEMPTS} attempts",
        family.prefix()
    )))
}
```

Delete `max_code_number` and `reserve_next_code_number`. `tasks.rs:70-71` → `let code = mint_unique_code(&state, CodeFamily::Task).await?;`. `cycles.rs:68-88`: explicit code → `if !code::is_valid_code(&explicit) { return Err(ApiError::bad_request(format!("invalid cycle code '{explicit}': expected S-<adjective>-<noun>-<tail> (see docs/adr/0003)"))); }` before the collision check; auto → `mint_unique_code(&state, CodeFamily::Cycle).await?`. Replace every listed `.to_ascii_uppercase()` with the plain stem (`let code = stem.to_string();` etc.). `index.rs`: remove the `code_counters` CREATE and `reserve_code_number`; append `DROP TABLE IF EXISTS code_counters;` to the schema `execute_batch` string. Remove the two index tests and the import.

- [ ] **Step 4: Verify pass** — `cargo test --test api_board_test && cargo test --test index_test && cargo test --test api_agenda_test && cargo test --lib` → PASS; `cargo fmt --check`.
- [ ] **Step 5: Commit** — `git commit -am "feat(board): mint petname codes with re-roll; codes are stems verbatim; drop code_counters"`

---

### Task 3: Unique-prefix addressing (server + MCP)

**Files:**
- Modify: `src/api/board/mod.rs` (`ensure_cycle_exists` :346-357 → returns canonical code; new `resolve_code`/`CodeLookup`)
- Modify: `src/api/board/tasks.rs` (cycle validation on create ~:109 and patch ~:201-210 store the CANONICAL code returned), `src/api/board/cycles.rs` (`carry_to` ~:288-325 resolves via `resolve_code`)
- Modify: `src/mcp/tasking.rs:59-68` (`classify_ref` no uppercase), `:97-116` (`find_board_id` prefix logic)
- Test: `tests/api_board_test.rs`, `src/mcp/tasking.rs` `mod tests`

**Interfaces:**
- Consumes: `code_stems` (Task 2).
- Produces in `src/api/board/mod.rs`:

```rust
pub(crate) enum CodeLookup { Found(String), NotFound, Ambiguous(Vec<String>) }
/// Resolve user input to a canonical stem of `kind`: exact case-insensitive
/// match wins; else a unique case-insensitive prefix; else NotFound/Ambiguous.
pub(crate) fn resolve_code(conn: &rusqlite::Connection, kind: Kind, input: &str) -> Result<CodeLookup, rusqlite::Error>;
/// Returns the canonical cycle code or a 400 (unknown / ambiguous, candidates listed).
async fn ensure_cycle_exists(state: &AppState, cycle_code: &str) -> Result<String, ApiError>;
```

- [ ] **Step 1: Write the failing tests.** `tests/api_board_test.rs`:

```rust
#[tokio::test]
async fn task_cycle_field_accepts_unique_prefix_and_stores_canonical() {
    let (server, _tmp, _state) = setup_server();
    let cyc = server.post("/api/vault/board/cycles")
        .json(&serde_json::json!({"label": "c", "code": "S-calm-heron-2xm9p"})).await;
    cyc.assert_status_ok();
    let task = server.post("/api/vault/board/tasks")
        .json(&serde_json::json!({"title": "t", "cycle": "s-CALM-heron"})).await;
    task.assert_status_ok();
    assert_eq!(task.json::<serde_json::Value>()["cycle"], "S-calm-heron-2xm9p");
}

#[tokio::test]
async fn ambiguous_cycle_prefix_is_rejected_with_candidates() {
    let (server, _tmp, _state) = setup_server();
    for code in ["S-calm-heron-2xm9p", "S-calm-otter-9k2ma"] {
        server.post("/api/vault/board/cycles")
            .json(&serde_json::json!({"label": "c", "code": code})).await.assert_status_ok();
    }
    let task = server.post("/api/vault/board/tasks")
        .json(&serde_json::json!({"title": "t", "cycle": "S-calm"})).await;
    task.assert_status_bad_request();
    let msg = task.text();
    assert!(msg.contains("S-calm-heron-2xm9p") && msg.contains("S-calm-otter-9k2ma"), "{msg}");
}
```

`src/mcp/tasking.rs` tests (extend the existing `mod tests`; build the `board` JSON the way its neighbours do):

```rust
#[test]
fn classify_ref_keeps_case_and_treats_prefix_as_code() {
    assert_eq!(classify_ref("  TSK-brave-finch  "), TaskRef::Code("TSK-brave-finch".into()));
    assert_eq!(classify_ref("tsk-brave-finch-7q3zd"), TaskRef::Code("tsk-brave-finch-7q3zd".into()));
}

#[test]
fn find_board_id_resolves_exact_prefix_and_reports_ambiguity() {
    let board = serde_json::json!({"tasks": [
        {"id": "id-1", "code": "TSK-brave-finch-7q3zd"},
        {"id": "id-2", "code": "TSK-brave-otter-9k2ma"},
        {"id": "id-3", "code": "TSK-calm-heron-2xm9p"},
    ], "cycles": []});
    assert_eq!(find_board_id(&board, BoardKind::Task, "tsk-BRAVE-finch-7q3zd").unwrap(), "id-1");
    assert_eq!(find_board_id(&board, BoardKind::Task, "TSK-calm").unwrap(), "id-3");
    let err = find_board_id(&board, BoardKind::Task, "TSK-brave").unwrap_err();
    assert!(err.contains("ambiguous") && err.contains("TSK-brave-finch-7q3zd") && err.contains("TSK-brave-otter-9k2ma"), "{err}");
    assert!(find_board_id(&board, BoardKind::Task, "TSK-zzz").unwrap_err().contains("no task"));
}
```

- [ ] **Step 2: Verify failure** — `cargo test --test api_board_test prefix && cargo test --lib tasking::tests` → FAIL.

- [ ] **Step 3: Implement.** `mod.rs`:

```rust
pub(crate) enum CodeLookup {
    Found(String),
    NotFound,
    Ambiguous(Vec<String>),
}

pub(crate) fn resolve_code(
    conn: &rusqlite::Connection,
    kind: Kind,
    input: &str,
) -> Result<CodeLookup, rusqlite::Error> {
    let needle = input.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return Ok(CodeLookup::NotFound);
    }
    let stems = code_stems(conn, kind)?;
    if let Some(exact) = stems.iter().find(|s| s.to_ascii_lowercase() == needle) {
        return Ok(CodeLookup::Found(exact.clone()));
    }
    let matches: Vec<String> = stems
        .iter()
        .filter(|s| s.to_ascii_lowercase().starts_with(&needle))
        .cloned()
        .collect();
    Ok(match matches.len() {
        0 => CodeLookup::NotFound,
        1 => CodeLookup::Found(matches.into_iter().next().expect("one")),
        _ => CodeLookup::Ambiguous(matches),
    })
}

async fn ensure_cycle_exists(state: &AppState, cycle_code: &str) -> Result<String, ApiError> {
    let input = cycle_code.to_string();
    let lookup = state
        .index
        .with_index(move |index, _vault| resolve_code(index.connection(), Kind::Cycle, &input))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;
    match lookup {
        CodeLookup::Found(code) => Ok(code),
        CodeLookup::NotFound => Err(ApiError::bad_request(format!(
            "unknown cycle '{cycle_code}'; must match an existing cycle code or a unique prefix of one"
        ))),
        CodeLookup::Ambiguous(c) => Err(ApiError::bad_request(format!(
            "ambiguous cycle prefix '{cycle_code}': candidates {}",
            c.join(", ")
        ))),
    }
}
```

Callers in `tasks.rs` (create + patch) now do `let canonical = ensure_cycle_exists(&state, c).await?;` and insert `canonical` into `meta.extra["cycle"]`. `cycles.rs` `carry_to`: when not `"BACKLOG"`, resolve through `resolve_code` (same error mapping) and use the canonical code both for the self-reference check and for the frontmatter rewrite. `tasking.rs`: `classify_ref` → `TaskRef::Code(input.to_string())`; `find_board_id`: collect `(code, id)` pairs for the kind; exact `eq_ignore_ascii_case` → id; else prefix matches by `to_ascii_lowercase().starts_with(&needle.to_ascii_lowercase())`: 1 → id; >1 → `Err(format!("ambiguous {noun} prefix '{code}': candidates {}", codes.join(", ")))`; 0 → the existing "no {noun} with code" message.

- [ ] **Step 4: Verify pass** — the four suites from Task 2 plus `cargo test --lib tasking::` → PASS; `cargo fmt --check`.
- [ ] **Step 5: Commit** — `git commit -am "feat(board): unique-prefix code resolution for cycles and MCP refs"`

---

### Task 4: Board task ordering by creation time

**Files:**
- Modify: `src/api/board/read.rs` (`load_tasks` query ~:400-420 adds `p.created_at`; `TaskListRow` gains `created_at: Option<String>`; sort at :477)
- Test: `tests/api_board_test.rs`

**Interfaces:** none new; `BoardTask` DTO unchanged (no schema regen).

- [ ] **Step 1: Write the failing test:**

```rust
#[tokio::test]
async fn board_lists_tasks_in_creation_order_not_code_order() {
    let (server, _tmp, _state) = setup_server();
    let mut created = Vec::new();
    for title in ["first", "second", "third"] {
        let r = server.post("/api/vault/board/tasks")
            .json(&serde_json::json!({"title": title})).await;
        r.assert_status_ok();
        created.push(r.json::<serde_json::Value>()["code"].as_str().unwrap().to_string());
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let board: serde_json::Value = server.get("/api/vault/board").await.json();
    let listed: Vec<String> = board["tasks"].as_array().unwrap().iter()
        .map(|t| t["code"].as_str().unwrap().to_string()).collect();
    assert_eq!(listed, created, "creation order, independent of the random codes");
}
```
(If the board endpoint is paginated or scoped, follow the file's own listing idiom.)

- [ ] **Step 2: Verify failure** — run it 3 times: `cargo test --test api_board_test creation_order` — with random codes the code-sorted board disagrees with creation order most runs → FAIL (if it passes by luck once, re-run; the sort is currently `a.code.cmp(&b.code)`).

- [ ] **Step 3: Implement.** Add `p.created_at` to the SELECT, thread it through `TaskListRow`, and replace line 477 with `tasks.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.code.cmp(&b.code)));` — where `created_at` here is the raw RFC3339 string from the row (lexicographic order == chronological for RFC3339 UTC). Keep `created_at` out of the public DTO. Leave `agenda.rs:787-815` and cycle/project sorts unchanged (cosmetic tie-breakers).

- [ ] **Step 4: Verify pass** — `cargo test --test api_board_test` → PASS 3 consecutive runs.
- [ ] **Step 5: Commit** — `git commit -am "feat(board): order tasks by creation time"`

---

### Task 5: `clep codes migrate` — recode legacy pages and rewrite prose tokens

**Files:**
- Create: `src/vault/recode.rs`
- Modify: `src/vault/mod.rs` (`pub mod recode;`), `src/vault/relabel.rs:41-99` (skip TASK/CYCLE pages — guard + test), `src/bin/cli.rs` (new `Codes { command: CodesCommands }` with `Migrate { write: bool }`; model the `Cas` family), `ui/src/docs/content/cli.mdx` (`## \`clep codes\``, `## \`clep codes migrate\``), `docs/design-notes/multi-file-mutation-audit.md` (one row)

**Interfaces:**
- Consumes: `code::{mint, is_valid_code, CodeFamily}`; `reconcile::move_page_to(vault, index, source, dest, hooks) -> Result<Option<String>, IndexError>` (src/vault/reconcile.rs:49); `conflict::has_conflict_markers`; `page::parse_or_repair_frontmatter` (4-tuple; `meta.encryption.is_some()` marks protected pages); `atomic_file::atomic_replace`; `VaultIndex::build` + `resolve_links`.
- Produces:

```rust
#[derive(Debug, Default)]
pub struct RecodeReport {
    pub renamed: Vec<(String, String)>,   // (old path, new path)
    pub rewritten: Vec<(String, usize)>,  // (path, tokens replaced)
    pub warnings: Vec<String>,
    pub dry_run: bool,
}
pub fn recode(vault: &Vault, index: &mut VaultIndex, write: bool) -> Result<RecodeReport, IndexError>;
```

- [ ] **Step 1: Write the failing tests** (in-module; build a vault with `init_vault`, write files, `VaultIndex::open` + `build` + `resolve_links` — the `tests/index_test.rs:17` `setup_vault` idiom):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::code::is_valid_code;

    const TASK_A: &str = "+++\nid = \"01900000-0000-7000-8000-00000000000a\"\ntitle = \"A\"\ntype = \"TASK\"\ncreated_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\nstatus = \"INTAKE\"\ncycle = \"S-1\"\n+++\nSee TSK-0002 and [[TSK-0002]].\n";
    const TASK_B: &str = "+++\nid = \"01900000-0000-7000-8000-00000000000b\"\ntitle = \"B\"\ntype = \"TASK\"\ncreated_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\nstatus = \"INTAKE\"\n+++\nbody\n";
    const CYCLE_1: &str = "+++\nid = \"01900000-0000-7000-8000-00000000000c\"\ntitle = \"One\"\ntype = \"CYCLE\"\ncreated_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\n+++\ncycle body\n";
    const NOTE: &str = "+++\nid = \"01900000-0000-7000-8000-00000000000d\"\ntitle = \"Snags\"\ncreated_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\n+++\nTSK-0001 blocks TSK-0002; TSK-9999 never existed; S-1 is the cycle.\n";

    fn fixture() -> (tempfile::TempDir, Vault, VaultIndex) {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        for (rel, content) in [
            ("tasks/proj/TSK-0001.md", TASK_A),
            ("tasks/proj/TSK-0002.md", TASK_B),
            ("cycles/S-1.md", CYCLE_1),
            ("notes/snags.md", NOTE),
        ] {
            let abs = root.join(rel);
            std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
            std::fs::write(abs, content).unwrap();
        }
        let vault = Vault::open(&root).unwrap();
        let mut index = VaultIndex::open(&tmp.path().join("cache.db")).unwrap();
        index.build(&vault).unwrap();
        index.resolve_links().unwrap();
        (tmp, vault, index)
    }

    fn read(vault: &Vault, rel: &str) -> String {
        std::fs::read_to_string(vault.root().join(rel)).unwrap()
    }

    #[test]
    fn dry_run_plans_everything_and_touches_nothing() {
        let (_tmp, vault, mut index) = fixture();
        let before = read(&vault, "notes/snags.md");
        let report = recode(&vault, &mut index, false).unwrap();
        assert!(report.dry_run);
        assert_eq!(report.renamed.len(), 3, "two tasks + one cycle");
        assert!(report.rewritten.iter().any(|(p, n)| p == "notes/snags.md" && *n == 3));
        assert!(vault.root().join("tasks/proj/TSK-0001.md").exists());
        assert_eq!(read(&vault, "notes/snags.md"), before);
    }

    #[test]
    fn write_renames_rewrites_links_prose_and_cycle_frontmatter() {
        let (_tmp, vault, mut index) = fixture();
        let report = recode(&vault, &mut index, true).unwrap();
        assert_eq!(report.renamed.len(), 3);
        let new_for = |old: &str| -> String {
            let (_, new_path) = report.renamed.iter().find(|(o, _)| o == old).unwrap();
            new_path.rsplit('/').next().unwrap().trim_end_matches(".md").to_string()
        };
        let a = new_for("tasks/proj/TSK-0001.md");
        let b = new_for("tasks/proj/TSK-0002.md");
        let s = new_for("cycles/S-1.md");
        assert!(is_valid_code(&a) && is_valid_code(&b) && is_valid_code(&s));
        assert!(!vault.root().join("tasks/proj/TSK-0001.md").exists());
        let a_body = read(&vault, &format!("tasks/proj/{a}.md"));
        assert!(a_body.contains(&format!("cycle = \"{s}\"")), "frontmatter cycle token rewritten: {a_body}");
        assert!(a_body.contains(&format!("[[{b}]]")), "wikilink rewritten by the move planner: {a_body}");
        assert!(a_body.contains(&format!("See {b} ")), "prose token rewritten: {a_body}");
        let note = read(&vault, "notes/snags.md");
        assert!(note.contains(&a) && note.contains(&b) && note.contains(&s), "{note}");
        assert!(note.contains("TSK-9999"), "unknown legacy token left alone");
        assert!(report.warnings.iter().any(|w| w.contains("TSK-9999")), "and warned about");
        // second run is a no-op
        let again = recode(&vault, &mut index, true).unwrap();
        assert!(again.renamed.is_empty() && again.rewritten.is_empty(), "{again:?}");
    }

    #[test]
    fn conflicted_page_is_skipped_with_warning() {
        let (_tmp, vault, mut index) = fixture();
        let clash = vault.root().join("notes/clash.md");
        std::fs::write(&clash, "+++\ntitle = \"c\"\n+++\n<<<<<<< HEAD\nTSK-0001\n=======\nx\n>>>>>>> theirs\n").unwrap();
        index.build(&vault).unwrap();
        let before = std::fs::read_to_string(&clash).unwrap();
        let report = recode(&vault, &mut index, true).unwrap();
        assert_eq!(std::fs::read_to_string(&clash).unwrap(), before);
        assert!(report.warnings.iter().any(|w| w.contains("notes/clash.md")));
    }

    #[test]
    fn canonical_scheme_task_without_code_gets_one() {
        let (_tmp, vault, mut index) = fixture();
        let rel = "tasks/proj/20260817.some-task.RZ6amN7D.md";
        std::fs::write(vault.root().join(rel), TASK_B).unwrap();
        index.build(&vault).unwrap();
        let report = recode(&vault, &mut index, true).unwrap();
        assert!(report.renamed.iter().any(|(o, n)| o == rel && is_valid_code(n.rsplit('/').next().unwrap().trim_end_matches(".md"))));
    }
}
```

Plus in `relabel.rs`'s test module: a TASK page `tasks/TSK-0481.md` (with created_at/updated_at) is `skipped`, not renamed, by `relabel(&vault, &mut index, false)`.

- [ ] **Step 2: Verify failure** — `cargo test --lib recode::` → FAIL (unresolved); `cargo test --lib relabel::` new test FAILS (relabel currently renames it).

- [ ] **Step 3: Implement.**

```rust
//! One-time migration to petname codes (docs/adr/0003): rename every
//! TASK/CYCLE page whose filename stem is not a valid code, rewriting
//! wikilinks through the move planner, then rewrite plain-text legacy
//! tokens (`TSK-0072`, `S-3`) across every page. Dry run by default.
//! This module is the ONLY place that recognizes the legacy format.

use std::collections::BTreeMap;
use std::sync::LazyLock;
use regex::Regex;

static LEGACY_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(TSK-\d{4}|S-\d+)\b").expect("static regex"));

pub fn recode(vault: &Vault, index: &mut VaultIndex, write: bool) -> Result<RecodeReport, IndexError> {
    let mut report = RecodeReport { dry_run: !write, ..Default::default() };

    // 1. Plan renames: every TASK/CYCLE page whose stem is not already a code.
    let rows: Vec<(String, String)> = {
        let mut stmt = index
            .connection()
            .prepare("SELECT path, kind FROM pages WHERE kind IN ('TASK', 'CYCLE') ORDER BY path")?;
        stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<_, _>>()?
    };
    let mut taken: BTreeSet<String> = rows.iter().map(|(p, _)| stem_of(p).to_string()).collect();
    let mut mapping: BTreeMap<String, String> = BTreeMap::new(); // old stem -> new code (legacy stems only)
    let mut planned: Vec<(String, String)> = Vec::new();          // (old path, new path)
    for (path, kind) in rows {
        let stem = stem_of(&path);
        if code::is_valid_code(stem) { continue; }
        let family = CodeFamily::from_kind(Kind::from_str(&kind)).expect("TASK/CYCLE");
        let new_code = loop { let c = code::mint(family); if taken.insert(c.clone()) { break c; } };
        let new_path = format!("{}/{new_code}.md", parent_of(&path));
        if is_legacy_stem(stem) { mapping.insert(stem.to_string(), new_code.clone()); }
        planned.push((path, new_path));
    }

    // 2. Execute renames (wikilinks rewritten by the move planner).
    for (old, new) in &planned {
        if write {
            match crate::vault::reconcile::move_page_to(vault, index, old, new, &[])? {
                Some(_) => report.renamed.push((old.clone(), new.clone())),
                None => report.warnings.push(format!("{old}: destination {new} already exists; not renamed")),
            }
        } else {
            report.renamed.push((old.clone(), new.clone()));
        }
    }

    // 3. Rewrite plain-text legacy tokens everywhere (frontmatter included —
    //    `cycle = "S-1"` is exactly such a token).
    // Re-queried AFTER the renames so rewritten pages are read at their new paths.
    let all_paths: Vec<String> = {
        let mut stmt = index.connection().prepare("SELECT path FROM pages ORDER BY path")?;
        stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<_, _>>()?
    };
    for path in all_paths {
        let abs = vault.resolve(&VaultPath::new(&path)?);
        let Ok(content) = std::fs::read_to_string(&abs) else { report.warnings.push(format!("{path}: cannot read")); continue };
        if !LEGACY_TOKEN.is_match(&content) { continue; }
        if crate::vault::conflict::has_conflict_markers(&content) { report.warnings.push(format!("{path}: contains merge conflict markers; skipped")); continue; }
        let (meta, _, _, _) = crate::vault::page::parse_or_repair_frontmatter(&content);
        if meta.encryption.is_some() { report.warnings.push(format!("{path}: encrypted; skipped")); continue; }
        let mut count = 0usize;
        let mut unknown: BTreeSet<String> = BTreeSet::new();
        let rewritten = LEGACY_TOKEN.replace_all(&content, |caps: &regex::Captures| {
            let tok = &caps[0];
            match mapping.get(tok) { Some(new) => { count += 1; new.clone() } None => { unknown.insert(tok.to_string()); tok.to_string() } }
        });
        for tok in unknown { report.warnings.push(format!("{path}: legacy token {tok} has no recoded page; left as is")); }
        if count == 0 { continue; }
        if write { crate::vault::atomic_file::atomic_replace(&abs, rewritten.as_bytes()).map_err(|e| IndexError::Other(e.to_string()))?; }
        report.rewritten.push((path, count));
    }

    // 4. Reindex so bodies, links and canonical names reflect the rewrites.
    if write { index.build(vault)?; index.resolve_links()?; }
    Ok(report)
}

fn is_legacy_stem(stem: &str) -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(TSK-\d{4}|S-\d+)$").expect("static regex"));
    RE.is_match(stem)
}
```

Helpers `stem_of(path) -> &str` (text after the last `/`, minus `.md`) and `parent_of(path) -> &str` are two-line private fns in this module. `Kind` parsing — use whatever `Kind` offers (`Kind::from_str`/`parse`) — check `src/vault/kind.rs`. Note the ordering subtlety: the mapping's old stems come from the PLANNED renames, so step 3 correctly rewrites `[[TSK-0002]]`-style tokens that the move planner already handled (they no longer match, count 0) and prose tokens (they do). The `atomic_replace` signature is `(path: &Path, content: &[u8])` — check `atomic_file.rs:350` and adapt.

`relabel.rs`: change the row query to `SELECT path, kind FROM pages ORDER BY path` and `continue` (counting `skipped`) when `kind` is `TASK` or `CYCLE`, with a comment pointing at this module.

CLI: `Commands::Codes { command: CodesCommands }`, `CodesCommands::Migrate { write: bool }` (dry run default). Arm: `let (vault, mut index) = open_vault_and_index()?;` → `recode(&vault, &mut index, write)?` → print each rename `old -> new`, each rewrite `path: N token(s)`, each warning, then a summary line with the dry-run hint; exit 1 if warnings non-empty else 0. `long_about` must say: stop `clep serve` first (the command opens the index directly), and that the migration is a one-time clean break with no legacy alias afterward. `cli.mdx`: `## \`clep codes\`` (family intro) and `## \`clep codes migrate\`` (what it renames, what it rewrites, skipped cases, exit codes, dry-run/`--write` examples, "stop the server first"). Add a row to `docs/design-notes/multi-file-mutation-audit.md` beside the relabel row.

- [ ] **Step 4: Verify pass** — `cargo test --lib recode:: && cargo test --lib relabel:: && cargo test --test docs_cli_coverage_test && cargo test --lib cli_tests::` → PASS; add a `Cli::try_parse_from` test for `codes migrate --write`; `cargo fmt --check`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(cli): clep codes migrate — recode legacy Task/Cycle pages and rewrite prose tokens"`

---

### Task 6: UI — server-minted cycle codes, code spans that tolerate long codes

**Files:**
- Modify: `ui/src/components/tasking/NewCycleModal.tsx:51-68,116` (remove client mint), `ui/src/components/tasking/CycleView.tsx:428` (`flex-shrink-0` → `min-w-0 truncate` on the code span), `ui/src/components/tasking/TaskCard.tsx:100-103` (add `truncate max-w-full` to the code span)
- Test: `ui/src/components/tasking/__tests__/cycleModals.test.tsx` (prefill expectations), and whichever CycleView/TaskCard tests snapshot class names

**Interfaces:** none new; the cycle-create request already allows `code` to be omitted (server auto-mints, Task 2).

- [ ] **Step 1: Write the failing tests.** In `cycleModals.test.tsx`, replace the assertions that expect a prefilled `S-<n>` with: the code input renders EMPTY with placeholder text `auto (assigned by the server)`, and submitting with an empty code omits the `code` field from the create payload (spy on the API client the file already mocks). Keep the label prefill test (`CYCLE n`) if the label derivation stays.

- [ ] **Step 2: Verify failure** — `cd ui && bun run test cycleModals` → FAIL.

- [ ] **Step 3: Implement.** In `NewCycleModal.tsx` delete the `nums`/`n` numeric derivation and the `code: \`S-${n}\`` template; prefill only `label` (derive `n` as `cycles.length + 1` for the label text only); code input `placeholder="auto (assigned by the server)"`; on submit, include `code` only when the trimmed input is non-empty. Class tweaks in `CycleView.tsx` and `TaskCard.tsx` as listed (a 24-character monospace code must not push the title out of a card).

- [ ] **Step 4: Verify pass** — `cd ui && bun run test tasking && bun run typecheck` → PASS; `bun run lint` shows no NEW errors in the three touched files.
- [ ] **Step 5: Commit** — `git commit -am "feat(ui): cycles get server-minted codes; code spans truncate"`

---

### Task 7: Neovim pattern, docs, and MCP instruction strings

**Files:**
- Modify: `nvim/lua/clepsydra/tasks.lua:8-19` (pattern), `nvim/tests/tasks_spec.lua`, `nvim/tests/routes_spec.lua`, `nvim/tests/picker_spec.lua` (fixture codes)
- Modify: `ui/src/docs/content/mcp.mdx:91-95,151,157,169`, `ui/src/docs/content/neovim.mdx:51-52`
- Modify: `.claude/skills/vault/SKILL.md:115,125`, `.claude/skills/onboard-project/SKILL.md:72`
- Modify: `src/mcp/server.rs` instruction/description strings at `:188,190,409,430,484,485,496,509,1266,1290,1329,1392,1425` (every `TSK-NNNN`, `TSK-0012`, `S-13`, `S-{n}`, `S-{max+1}` mention → the new shape and the prefix-addressing rule)

**Interfaces:** none.

- [ ] **Step 1: Write the failing Lua tests.** In `nvim/tests/tasks_spec.lua` change `extract_code` fixtures: cword `TSK-brave-finch-7q3zd,` → `"TSK-brave-finch-7q3zd"`; bufname `/v/tasks/x/TSK-calm-heron-2xm9p.md` → `"TSK-calm-heron-2xm9p"`; `TSK-0012` (legacy) → `nil`; `tsk-brave-finch-7q3zd` (lowercase prefix) → `"TSK-brave-finch-7q3zd"` (prefix normalized to upper, body kept lower). Update the codes embedded in `routes_spec.lua`/`picker_spec.lua` to valid new-format strings (they are passthrough data).

- [ ] **Step 2: Verify failure** — `nvim --headless -l nvim/tests/run.lua` → tasks_spec FAILS on the new cases. (If `nvim` is not on PATH, report NEEDS_CONTEXT immediately with `which nvim` output.)

- [ ] **Step 3: Implement.**

```lua
--- Extract a task code from the word under the cursor, falling back to the
--- buffer's file name (task pages are named after their code). Pure.
--- Codes are `TSK-<adjective>-<noun>-<tail>` (docs/adr/0003): the prefix is
--- case-insensitive on input, the body stays lowercase.
---@return string|nil code e.g. "TSK-brave-finch-7q3zd"
function M.extract_code(cword, bufname)
	local function find(s)
		local body = s:match("[Tt][Ss][Kk]%-([%l%d]+%-[%l%d]+%-[%l%d]+)")
		return body and ("TSK-" .. body) or nil
	end
	return find(cword) or find(vim.fs.basename(bufname))
end
```

Docs: rewrite the listed mdx/SKILL lines to describe `TSK-<adjective>-<noun>-<tail>` / `S-…`, that the server mints codes, and that any unique prefix (`TSK-brave-finch`) addresses a page. `server.rs` strings: same content; the `instructions` string at `:188-190` must state the format and the prefix rule since it is what agents read first. Run `cargo test --lib mcp::` afterwards (string changes can break snapshot-style assertions — fix the assertions, not the wording).

- [ ] **Step 4: Verify pass** — `nvim --headless -l nvim/tests/run.lua` all green; `cargo test --lib mcp::`; `cd ui && bun run typecheck` (mdx compiles).
- [ ] **Step 5: Commit** — `git commit -am "docs(codes): petname format in nvim pattern, MCP instructions, skills, and docs"`

---

## Final verification gates (after Task 7)

- [ ] `cargo test` (bare, read the end), `cargo clippy` (zero warnings), `cargo fmt --check`
- [ ] `cd ui && bun run typecheck && bun run test` ; `bun run lint` no new errors in touched files
- [ ] `nvim --headless -l nvim/tests/run.lua`
- [ ] Whole-branch review, then merge via a temporary `develop-merge` worktree (never in the main checkout), full suite on the merged result.
- [ ] Post-merge, separately: `clep codes migrate` dry run against the live vault with `clep serve` stopped → present the plan → `--write` only on explicit confirmation.


## Appendix A — `src/vault/wordlists/adjectives.txt` (512, one per line, this order)

```
able
aged
agile
airy
alert
amber
ample
amused
apart
apt
arctic
ardent
arid
artful
august
awake
aware
azure
bald
balmy
basic
beady
beige
bent
best
black
bland
blank
blithe
blond
bluish
blunt
boggy
bold
bony
boxy
brainy
brash
brassy
brave
breezy
brief
bright
briny
brisk
broody
brown
bubbly
bulky
bumpy
burnt
bushy
busy
cagey
calm
catty
chalky
chatty
cheap
cheeky
chewy
chief
chill
chilly
choppy
civic
civil
classy
clean
clear
close
cloudy
clumsy
coarse
cold
cool
corny
cosmic
costly
cosy
crafty
cranky
creaky
creamy
crisp
cubic
cuddly
curly
curvy
cute
dainty
damp
dapper
dark
dear
deft
dense
dewy
dim
dizzy
droll
drowsy
dry
dual
dull
dusty
eager
early
earthy
easy
eerie
elder
elfin
empty
equal
exact
extra
fabled
faded
faint
fancy
far
fast
feisty
feral
fickle
fiery
filmy
final
fine
fit
fixed
flaky
flashy
flat
flimsy
floppy
floral
fluffy
fluid
foamy
folksy
fond
formal
frail
free
fresh
frigid
frilly
frisky
frothy
frugal
funky
furry
fussy
gaudy
gaunt
gentle
giant
giddy
glad
glassy
glib
gloomy
glossy
gnarly
godly
golden
good
goofy
grand
grassy
grave
gray
greasy
green
grim
gruff
grumpy
gusty
handy
happy
hardy
harsh
hasty
hearty
heavy
hefty
heroic
hidden
hoarse
hokey
hollow
holy
honest
humble
humid
husky
iconic
icy
inky
inner
itchy
jaded
jagged
jazzy
jolly
jovial
juicy
jumbo
keen
kind
kindly
kingly
knobby
large
last
late
latent
lavish
leaden
leafy
lean
left
legal
light
limber
limp
limpid
lithe
lively
loamy
local
lofty
lone
loose
lost
loud
loved
low
loyal
lucid
lucky
lumpy
lunar
lyric
magic
main
major
manic
marine
marshy
mature
mauve
mean
meek
mellow
merry
messy
mighty
milky
minor
minty
misty
modern
moist
moody
mossy
mousy
muddy
murky
mushy
musty
mute
mystic
natal
native
naval
navy
near
neat
nervy
new
nice
nifty
noble
noisy
nordic
nosy
novel
oaken
oblong
oily
old
only
open
ornate
outer
oval
overt
pallid
paltry
pastel
pasty
peachy
pebbly
peppy
perky
petty
picky
placid
plain
plucky
plump
plush
poised
polar
polite
portly
posh
prime
prior
prized
proper
proud
punchy
pure
quaint
quick
quiet
rainy
rakish
rangy
rapid
rare
raw
ready
real
regal
rich
rigid
ripe
risky
roomy
rosy
round
rowdy
royal
ruddy
rugged
rustic
rusty
sacred
sad
safe
sandy
sane
sappy
sassy
saucy
scaly
scant
scenic
seedy
serene
shaky
sharp
sheer
shiny
short
shrewd
shy
silent
silky
silly
simple
sinewy
sleek
slim
slimy
slushy
sly
small
smart
smiley
smooth
smug
snappy
snazzy
snowy
sober
sodden
soft
soggy
solar
sonic
sooty
sore
sour
spare
speedy
spicy
spiky
spiral
spongy
spry
spunky
squat
stale
stark
steely
steep
stern
stiff
still
stony
stormy
stout
stray
strict
stuffy
sturdy
subtle
sudden
sugary
sultry
sunlit
sunny
super
supple
svelte
swampy
swanky
sweet
swift
tacky
tall
tame
tan
tangy
tasty
taut
tawny
tender
tense
terse
thick
thin
thorny
tidal
tight
timid
tingly
tiny
tired
tonal
toothy
top
torrid
total
trendy
tricky
trim
tropic
true
tufty
tweedy
twin
ultra
uneven
unlit
unseen
upbeat
upper
urban
vague
vain
valid
varied
vast
vexed
viable
vital
vivid
vocal
wacky
warm
wary
wavy
weak
wee
weird
wet
white
whole
wild
windy
wintry
wiry
wise
witty
wobbly
woken
wooden
woolen
wordy
worn
woven
wry
yellow
zany
zesty
```

## Appendix B — `src/vault/wordlists/nouns.txt` (512, one per line, this order)

```
acorn
alder
aloe
anchor
ant
antler
anvil
ape
arch
arrow
ash
asp
atlas
auk
aurora
avocet
baboon
badge
badger
bagel
bamboo
banjo
bantam
barge
barn
basil
basin
basket
bat
baton
bay
beach
bead
beaker
beam
bean
beaver
bee
beech
beetle
belt
bench
berry
birch
bison
blade
bloom
boat
bolt
bone
bonnet
book
bosun
bottle
bough
bowl
branch
brass
bread
brick
brine
bronze
brook
broom
buckle
bud
bugle
bull
burrow
bush
cabin
cable
cairn
camel
camera
canal
candle
canoe
canvas
canyon
caper
carp
carrot
cashew
cat
cattle
cavern
cedar
cello
chain
chair
chalk
cherry
chime
chisel
cider
clam
cliff
cloak
clock
clove
clover
coal
cobalt
cocoa
cod
coffee
collie
condor
cone
cookie
copper
cork
corn
cot
cougar
cow
coyote
crab
cradle
crater
creek
crest
crocus
crumb
cub
cuckoo
cup
cutter
dagger
dahlia
daisy
dart
dawn
deer
delta
dew
dingo
dipper
dock
dome
donkey
dory
dove
drum
duck
dune
dunlin
eagle
earth
eel
egret
elm
ember
emu
enamel
ermine
falcon
fawn
fennel
ferret
ferry
fiddle
fig
finch
fir
fjord
flag
flask
fleece
flint
flower
fly
foal
fog
forge
fossil
fox
frog
gale
garden
garnet
gate
gecko
geyser
ghost
gibbon
gift
ginger
glade
glen
globe
gnu
goat
goblet
goblin
goose
gopher
gorge
gourd
grape
grass
grouse
grove
gull
hail
hamlet
hammer
hare
harp
hawk
hazel
helmet
hen
hermit
heron
hive
hog
holly
honey
horn
hornet
horse
hound
ibis
idol
igloo
iguana
ink
iris
iron
isle
jackal
jade
jaguar
jar
jay
jerboa
jet
jewel
kayak
keg
kelp
kernel
key
kiln
kite
kitten
knot
koala
lace
ladder
lagoon
lake
lamb
lamp
lasso
latch
laurel
lawn
lemon
lentil
lichen
lilac
lime
limpet
linen
lion
llama
lobby
locket
lodge
log
loom
lotus
lupin
lynx
macaw
mace
magma
mallet
mango
manor
map
marlin
marsh
marten
mask
mat
meadow
melon
mesa
minnow
mint
mitten
mole
moon
moose
mop
mortar
moss
moth
mouse
muffin
mule
mullet
murre
myrtle
nettle
newt
nickel
noodle
nutmeg
oak
oar
oasis
ocean
ocelot
onion
orange
orca
orchid
oriole
osprey
owl
oyster
pad
paddle
pan
panda
pansy
pantry
parrot
paw
peach
pear
pebble
pecan
peg
pen
peony
pepper
petal
pewter
pickle
pig
pigeon
pike
pillow
pin
pine
pipit
plank
plover
plow
plum
pod
pollen
pond
pony
poppy
porch
pot
potato
prism
puddle
puffin
pug
pup
puppet
quail
quartz
quilt
quince
quokka
rabbit
raft
rain
raisin
ram
raven
ravine
razor
reed
rib
ribbon
ridge
rig
river
robin
rock
rocket
rook
root
rope
rose
ruffle
rug
rune
saddle
sail
salmon
salvia
sand
sap
saw
scarf
seal
sesame
shark
shawl
shed
sherry
ship
shoal
shore
shrimp
shrub
sickle
silk
skunk
sky
sled
sloth
snail
snow
sod
sofa
sorbet
sorrel
spear
spider
spool
spoon
sprout
spruce
squid
stag
stanza
star
steam
stoat
stone
stork
stove
straw
stream
sugar
swan
sword
tab
tabby
tag
tallow
talon
tapir
tassel
tea
teacup
temple
thrush
tiger
timber
tin
toffee
tomato
tongs
topaz
toucan
tower
trout
trowel
tub
tug
tulip
tuna
turbot
tureen
turkey
turnip
twig
urn
valley
van
vat
vessel
vicuna
vine
violet
waffle
wagon
walnut
wasp
water
wave
wax
web
weevil
whale
wheat
wicket
wig
wigeon
willet
wind
window
winkle
wolf
wren
yak
yam
yarn
```
