# Capture Pipeline Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SingleFile capture transport, storage limits, resource joining, and interrupted-transfer cleanup reliable before archived-page viewer implementation.

**Architecture:** Preserve the current extension → archive API → CAS artifact contract. Fix server budget enforcement and structural joining independently, then harden the extension's snapshot and resource transports. Finish with real-browser capture verification and repository-wide gates.

**Tech Stack:** Rust 2024, Axum 0.8, pulldown-cmark 0.12, rusqlite, TypeScript 5.9, Chrome/Firefox extension APIs, Vite 6, Vitest 3, SingleFile Core 1.5.84.

**Spec:** `docs/superpowers/specs/2026-08-13-capture-pipeline-stabilization-design.md`

## Global Constraints

- The archived-page viewer is out of scope; raw HTML CAS blobs remain attachment-only.
- `archive.max_request_size_mb` is the decoded semantic budget and includes deconstructed snapshot HTML, unique decoded resources, and captured Markdown.
- `archive_body_limit_bytes` returns twice the decoded budget plus 1 MiB using saturating arithmetic.
- The relay page-fetch-first behavior and existing fetch options remain unchanged.
- Relay protocol uses one `runtime.Port` named `singlefile-relay` per resource, pull/ack flow control, and at most 4 MiB of raw bytes per chunk.
- Snapshot chunks are lazy, bounded, validated, idempotent for exact duplicate delivery, and cleared on completion, abort, expiry, or tab closure.
- HTML joining must be quote-aware; Markdown image rewriting must use pulldown-cmark source offsets and preserve unchanged bytes.
- No server-side streaming ingest redesign in this pass.
- Every behavior change follows red-green TDD and receives a task-scoped review before the next task.

---

### Task 1: Correct Archive Budget Boundaries

**Files:**
- Modify: `src/api/archive.rs`
- Modify: `tests/archive_test.rs`

**Interfaces:**
- Consumes: `ArchiveRequest.markdown_body`, `Deconstructed.html`, `SnapshotResource.bytes`.
- Produces: `archive_body_limit_bytes(max_request_size_mb: u64) -> usize`; `validate_resource_sizes(..., markdown_len: usize, ...) -> Result<(), ApiError>`.

- [ ] **Step 1: Add failing unit tests for semantic and transport budgets**

Add tests proving:

```rust
#[test]
fn markdown_bytes_count_toward_the_capture_budget() {
    let resources = Vec::new();
    let error = validate_resource_sizes(&resources, 1024 * 1024, 1024 * 1024 + 1, 100, 2)
        .expect_err("snapshot plus markdown exceeds two MiB");
    assert!(error.error.contains("max_request_size_mb"));
}

#[test]
fn body_limit_is_twice_budget_plus_envelope_headroom() {
    assert_eq!(archive_body_limit_bytes(2), 5 * 1024 * 1024);
}

#[test]
fn body_limit_saturates_for_unrepresentable_budgets() {
    assert_eq!(archive_body_limit_bytes(u64::MAX), usize::MAX);
}
```

Update exact integer types where compilation requires it without weakening the assertions.

- [ ] **Step 2: Run focused unit tests and verify RED**

Run: `cargo test api::archive::tests::markdown_bytes_count_toward_the_capture_budget api::archive::tests::body_limit_ -- --nocapture`

Expected: compilation or assertion failure because the validator lacks Markdown and the body-limit formula is still 4/3.

- [ ] **Step 3: Add a failing production-router integration test**

In `tests/archive_test.rs`, construct a small-limit fixture through the production archive-limit wiring. Post a valid JSON request whose body is larger than the former 4/3 allowance but whose decoded snapshot, resources, and Markdown remain within the configured budget. Assert it returns `201 CREATED`, not `413 PAYLOAD_TOO_LARGE`.

- [ ] **Step 4: Run the integration test and verify RED**

Run: `cargo test --test archive_test request_above_base64_only_allowance_reaches_archive_validation -- --exact --nocapture`

Expected: FAIL with 413 under the old transport formula.

- [ ] **Step 5: Implement checked semantic accounting and saturating transport allowance**

Change `validate_resource_sizes` to sum snapshot, unique resources, and Markdown with `checked_add`; overflow returns the same `max_request_size_mb` bad request. Implement:

```rust
pub(crate) fn archive_body_limit_bytes(max_request_size_mb: u64) -> usize {
    let budget = usize::try_from(max_request_size_mb)
        .unwrap_or(usize::MAX)
        .saturating_mul(1024 * 1024);
    budget.saturating_mul(2).saturating_add(1024 * 1024)
}
```

Pass `req.markdown_body.len()` from `ingest_archive`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `cargo test api::archive::tests --lib`

Run: `cargo test --test archive_test request_above_base64_only_allowance_reaches_archive_validation -- --exact`

Expected: PASS.

- [ ] **Step 7: Commit**

Commit message: `fix(archive): separate transport and decoded budgets`

---

### Task 2: Parse Resource References Structurally

**Files:**
- Modify: `src/vault/archive_snapshot.rs`
- Test: `src/vault/archive_snapshot.rs`

**Interfaces:**
- Consumes: deconstructed snapshot HTML and captured Markdown.
- Produces: unchanged public signatures `original_url_map(html, base_url)` and `rewrite_markdown_images(markdown, map, base_url)`.

- [ ] **Step 1: Add failing HTML join tests**

Add tests where:

```rust
let html = r#"<img data-sf-original-src="https://cdn.example/a'b>c.png?x=1&amp;y=2" src="cas:sha256:aa">"#;
```

The map must contain `https://cdn.example/a'b%3Ec.png?x=1&y=2` with hash `sha256:aa`. Add a second case with single-quoted attributes containing a double quote, whitespace/newlines between attributes, and distracting `data-sf-original-srcset`/`srcset` fields.

- [ ] **Step 2: Add failing Markdown rewrite tests**

Cover:

```rust
![plot](https://cdn.example/plot_(final).png "Final")
![spaced](<https://cdn.example/a b.png> "Caption")
```

Assert only destination bytes become `cas:sha256:...`, while alt text, titles, surrounding text, and ordinary links remain unchanged.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `cargo test vault::archive_snapshot::tests --lib`

Expected: new HTML and Markdown edge cases fail under regex parsing.

- [ ] **Step 4: Implement quote-aware HTML scanning**

Replace `tag_regex`, `original_src_regex`, and `cas_src_regex` with private scanners that:

- find `>` only outside quoted attribute values;
- parse exact attribute names case-insensitively;
- use the active quote delimiter rather than excluding both quote characters;
- pair `data-sf-original-src` and `src="cas:..."` only inside one tag;
- retain current entity decoding and URL absolutisation.

Do not build a DOM or copy the whole snapshot per tag.

- [ ] **Step 5: Implement pulldown-cmark-guided image destination rewriting**

Use `Parser::new_ext(markdown, Options::all()).into_offset_iter()` to identify image start events and their source ranges. Within each image source range, locate the destination with a small balanced scanner supporting `<...>`, backslash escapes, balanced parentheses, whitespace, and optional titles. Collect non-overlapping replacement ranges, then build one output string in source order. Leave malformed or unmatched destinations untouched.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `cargo test vault::archive_snapshot::tests --lib`

Expected: PASS.

- [ ] **Step 7: Commit**

Commit message: `fix(archive): parse snapshot resource references structurally`

---

### Task 3: Bound Snapshot Chunk State

**Files:**
- Modify: `extension/src/lib/chunked-transfer.ts`
- Modify: `extension/src/lib/__tests__/chunked-transfer.test.ts`
- Modify: `extension/src/content/capture.ts`
- Modify: `extension/src/background/service-worker.ts`
- Add or modify the closest existing worker/capture unit test when extracting lifecycle logic.

**Interfaces:**
- Produces: `splitIntoChunks(...): Iterable<CaptureChunk>`; validated `ChunkAssembler`; `capture_abort` message; one inactivity timeout per pending capture.
- Consumes: existing `CAPTURE_CHUNK`, `CaptureQueue`, badge phases, and tab-removal cleanup.

- [ ] **Step 1: Add failing lazy-generation and validation tests**

Tests must prove:

- `splitIntoChunks` returns an iterable, not an array, and slicing occurs only as iteration advances;
- invalid totals and indices throw;
- chunks over `CHUNK_SIZE` throw;
- a changed total throws;
- exact duplicate chunks are idempotent;
- conflicting duplicate chunks throw;
- failure removes assembler state.

Use `Array.from(splitIntoChunks(...))` only in tests requiring all chunks.

- [ ] **Step 2: Run chunk tests and verify RED**

Run: `bun run test -- lib/__tests__/chunked-transfer.test.ts`

Expected: new tests fail against eager generation and permissive assembly.

- [ ] **Step 3: Implement lazy generation and validated assembly**

Convert `splitIntoChunks` to a generator. Store `{ total, parts }` per capture. Validate before mutation; on malformed input delete the capture buffer and throw an actionable error.

- [ ] **Step 4: Run chunk tests and verify GREEN**

Run: `bun run test -- lib/__tests__/chunked-transfer.test.ts`

Expected: PASS.

- [ ] **Step 5: Add failing lifecycle tests**

Extract a focused pending-transfer coordinator if needed. With fake timers, prove completion, explicit abort, inactivity expiry, and tab closure each remove assembler data, metadata, and timers. Prove accepted metadata/chunks reset inactivity.

- [ ] **Step 6: Run lifecycle tests and verify RED**

Run the exact new test file with Vitest. Expected: timeout/abort behavior is absent.

- [ ] **Step 7: Implement lifecycle cleanup and content abort**

Use one coordinator-owned timer per capture. Add `{ type: "capture_abort", captureId, error }`. In `capture.ts`, after creating a capture ID, wrap metadata/chunk sends; on failure attempt abort, then rethrow so the existing capture error path reports the failure. In the worker, malformed chunks, aborts, expiry, completion, and tab removal all clear coordinated state.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run chunk and lifecycle test files. Expected: PASS.

- [ ] **Step 9: Commit**

Commit message: `fix(extension): bound capture chunk lifecycle`

---

### Task 4: Stream Relayed Resources Over a Port

**Files:**
- Modify: `extension/src/lib/relay-fetch.ts`
- Modify: `extension/src/lib/__tests__/relay-fetch.test.ts`
- Modify: `extension/src/background/service-worker.ts`
- Modify types only where required by the protocol.

**Interfaces:**
- Produces: port name `singlefile-relay`; metadata/chunk/pull/abort message union; content-side `createRelayFetch` returning the existing `SingleFileResponse` shape.
- Consumes: direct page fetch first; worker fetch fallback with cache, credentials, headers, referrer policy, and timeout behavior unchanged.

- [ ] **Step 1: Add failing framing tests**

Build a fake paired port and a synthetic resource larger than 4 MiB. Assert exact reconstructed bytes, response status, final URL, and lower-cased headers. Record every worker-to-content message and assert no chunk represents more than 4 MiB raw bytes and only one chunk is outstanding before pull/ack.

- [ ] **Step 2: Add failing disconnect tests**

Prove premature disconnect rejects the content fetch and aborts/releases the worker transfer. Prove fetch errors cross the port as readable failures.

- [ ] **Step 3: Run relay tests and verify RED**

Run: `bun run test -- lib/__tests__/relay-fetch.test.ts`

Expected: fail because relay still uses one `sendMessage` base64 response.

- [ ] **Step 4: Implement port protocol**

Keep direct `globalThis.fetch` unchanged. On fallback, open one `chrome.runtime.connect({ name: "singlefile-relay" })` port. Worker connection handling fetches once, posts metadata, and sends the next bounded base64 chunk only in response to pull/ack. Include `response.url`. Abort fetch and release buffers on disconnect. Do not retain the old `RELAY_FETCH` `sendMessage` path or compatibility alias.

- [ ] **Step 5: Run relay and extension tests and verify GREEN**

Run: `bun run test -- lib/__tests__/relay-fetch.test.ts`

Run: `bun run test`

Expected: PASS.

- [ ] **Step 6: Commit**

Commit message: `fix(extension): stream relayed resources over ports`

---

### Task 5: Runtime Verification and Documentation

**Files:**
- Modify: `docs/superpowers/plans/2026-08-12-fidelity-capture-manual-verification.md`
- Modify user-facing extension/archive documentation only if observed behavior differs from current text.

**Interfaces:**
- Consumes: completed stabilization branch, built Chromium extension, scratch vault server.
- Produces: recorded evidence for real capture behavior, large relay transfer, URL joining, cleanup symptoms, and server resident memory.

- [ ] **Step 1: Build production extension bundles**

Run in `extension/`:

```text
bun run typecheck
bun run lint
bun run build
bun run build:firefox
```

Expected: all pass, including bundle verification.

- [ ] **Step 2: Launch a scratch-vault server and installed Chromium extension**

Use a disposable vault. Launch the built extension in a real Chromium browser through the available browser/Playwright tooling. Configure its server URL to the scratch server.

- [ ] **Step 3: Exercise the manual capture matrix**

Complete every check in `2026-08-12-fidelity-capture-manual-verification.md`. Additionally capture:

- a page whose worker-relayed cross-origin resource exceeds 4 MiB;
- image URLs with query parameters and balanced parentheses;
- an interrupted capture, confirming no stuck processing badge or retained transfer state after expiry/abort.

Inspect stored Markdown and snapshot bytes to prove captured resources use `cas:` and unmatched resources are not falsely claimed.

- [ ] **Step 4: Record memory and outcomes**

Record the server RSS before and at peak during the largest capture, payload characteristics, browser/version, and pass/fail outcome for each check directly in the manual-verification document. Do not claim inline snapshot rendering; raw HTML remains download-only.

- [ ] **Step 5: Run full repository gates**

Run:

```text
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test
bun run typecheck        # extension
bun run lint             # extension
bun run test             # extension
bun run build             # extension Chromium
bun run build:firefox     # extension Firefox
bun run typecheck         # ui
bun run lint              # ui
bun run test              # ui
```

Expected: all pass. Report any pre-existing warnings separately; do not suppress them.

- [ ] **Step 6: Commit verification evidence**

Commit message: `docs(archive): record stabilized capture verification`
