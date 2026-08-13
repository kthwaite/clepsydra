# Capture Pipeline Stabilization Design

**Status:** Proposed for implementation
**Date:** 2026-08-13

## Summary

Stabilize the recently merged SingleFile capture pipeline before building the archived-page viewer. The work fixes transport limits, large-resource relay, resource-reference joining, abandoned chunk state, and avoidable extension-side chunk allocation. It preserves the existing artifact contract: the extension posts one SingleFile snapshot with inlined resources; the server deconstructs it into CAS blobs and stores `cas:` references.

The archived-page viewer remains a separate follow-up governed by `2026-08-12-archived-page-viewer-design.md`.

## Goals

- Accept extension-generated captures up to the configured decoded-content budget without a premature HTTP 413.
- Transfer a cross-origin resource without placing its complete base64 representation in one extension message.
- Join legal HTML original-URL attributes and legal Markdown image destinations to the same CAS resource map.
- Reject malformed capture chunks and release incomplete capture state after abort, expiry, or tab closure.
- Send snapshot chunks lazily rather than materializing a second snapshot-sized array.
- Complete the outstanding real-browser verification against the changed transport.

## Non-goals

- Implementing the archived-page viewer.
- Streaming server-side JSON parsing or snapshot deconstruction. Peak server memory will be measured during browser verification; a streaming ingest redesign requires a separate design if the measured headroom is unacceptable.
- Changing duplicate detection, capture history, or the one-archive-per-URL model.
- Adding retries or a durable background upload queue.
- Weakening CAS attachment or sandbox protections.

## Transport budget

`archive.max_request_size_mb` remains the decoded capture budget. Application validation counts:

- deconstructed snapshot HTML bytes;
- unique decoded resource bytes; and
- captured Markdown bytes.

All additions use checked arithmetic and reject overflow as an over-budget capture.

The Axum body limit is a transport guard, not the semantic budget. `archive_body_limit_bytes` will allow twice the decoded budget plus 1 MiB of envelope headroom, using saturating arithmetic. This covers base64 expansion and normal JSON escaping produced by the extension while leaving application validation responsible for the configured limit and its actionable error. Metadata remains bounded by the transport guard rather than receiving a second set of field-specific limits.

Tests must prove that Markdown contributes to the decoded budget and that a JSON request larger than the former 4/3 body limit reaches application validation under the production router limit.

## Large-resource relay

The page-context fetch remains first because it carries the page session. Cross-origin fallback moves from one `sendMessage` response to a dedicated `runtime.Port` named `singlefile-relay`.

Each port carries exactly one fetch:

1. The content script opens the port and posts `{ url, headers }`.
2. The worker fetches with the existing timeout, credential, cache, header, and referrer behavior.
3. The worker posts response metadata: status, final URL, lower-cased headers, and byte length.
4. The content script requests the next chunk.
5. The worker base64-encodes and posts at most 4 MiB of bytes.
6. The content script decodes and appends the chunk, then requests the next one.
7. The worker disconnects after the final acknowledgement; either side treats premature disconnect as failure.

The pull/ack cadence bounds queued message memory to one encoded chunk. The worker may retain the fetched `ArrayBuffer` for the request, but it never constructs a resource-sized base64 string. Disconnect aborts an in-flight fetch and releases its bytes.

The relay implementation remains injectable so unit tests exercise the real framing and assembly logic without Chrome.

## Snapshot chunk lifecycle

`splitIntoChunks` becomes an iterable generator. Existing callers use it directly; tests use `Array.from` only when they need random access.

`ChunkAssembler` records one immutable `total` per capture and rejects:

- non-integer or non-positive totals;
- non-integer indices;
- indices outside `[0, total)`;
- chunks larger than `CHUNK_SIZE`;
- conflicting duplicate chunks; and
- a later chunk whose `total` differs from the first.

Exact duplicate delivery is idempotent. Each incomplete capture owns an inactivity timer that is reset by accepted metadata or chunks. Expiry removes both assembled chunks and pending metadata and reports an error phase. Completion, an explicit `capture_abort`, and tab closure cancel the timer and release both maps. The content script sends `capture_abort` when metadata transfer or any chunk send fails; failure to send the abort is harmless because expiry and tab closure remain backstops.

## Structural resource joining

### HTML

Replace the tag and original-URL regular expressions with a quote-aware scanner. It identifies tag boundaries while respecting single- and double-quoted attribute values, then scans attributes using the attribute's actual delimiter. It extracts `data-sf-original-src` and `src` only from the same tag. Attribute entity decoding and URL absolutisation remain unchanged.

This deliberately avoids a DOM tree: snapshots can be hundreds of megabytes, and the join needs only local tag/attribute structure. Tests cover `>` inside quoted URLs, apostrophes inside double-quoted URLs, entity-encoded query strings, unrelated `srcset`, and attributes split by whitespace.

### Markdown

Use the existing `pulldown-cmark` parser with source offsets to identify image nodes. For each image source range, a small destination scanner locates the destination while respecting angle-bracket destinations, escapes, balanced parentheses, whitespace, and optional titles. Only the destination bytes are replaced; alt text, title spelling, surrounding whitespace, and unrelated Markdown remain byte-for-byte unchanged.

Malformed Markdown and unmatched resource URLs remain unchanged. Tests cover balanced parentheses, angle-bracket destinations containing spaces, titles, relative URLs, and ordinary links.

## Memory

Lazy snapshot chunk generation removes the extension's avoidable array of every snapshot substring. Pull-based relay framing removes the complete base64 relay allocation and bounds queued encoded data to one chunk.

Server-side deconstruction remains buffered for this stabilization pass. Browser verification records the server's resident-memory increase for a media-heavy capture. A separate streaming design is required only if the measurement exceeds acceptable operational headroom.

## Error handling

- Relay fetch, framing, decoding, or disconnect errors surface through the existing capture failure notification.
- Invalid snapshot chunks fail the affected capture, clear its state, and do not poison later captures.
- Expired transfers report a specific timeout message.
- Budget failures remain HTTP 400 responses naming `max_blob_size_mb` or `max_request_size_mb`; the transport guard may still return 413 for payloads materially larger than its envelope allowance.

## Testing

### Extension

- Relay a synthetic resource larger than one chunk and assert exact bytes, status, URL, and headers.
- Assert no relay message contains more than one configured chunk.
- Assert disconnect aborts and releases the worker-side transfer.
- Assert snapshot chunks are generated lazily.
- Assert malformed totals, indices, conflicting duplicates, and changed totals are rejected.
- Assert abort and expiry release assembler and metadata state.

### Server

- Assert Markdown bytes count toward `max_request_size_mb`.
- Assert body-limit arithmetic saturates rather than overflowing.
- Post a request exceeding the former 4/3 transport allowance but within the decoded budget and assert it reaches the archive handler.
- Assert original URLs containing `>` and apostrophes join correctly.
- Assert Markdown image destinations with balanced parentheses and angle brackets rewrite correctly.
- Preserve existing deconstruction, deduplication, rollback, and CAS-serving tests.

### Runtime verification

Complete `docs/superpowers/plans/2026-08-12-fidelity-capture-manual-verification.md`, adding one cross-origin resource larger than 4 MiB and one image URL containing query parameters or parentheses. Record observed server memory for the largest capture. Raw snapshot HTML continues to download; inline rendering remains the viewer feature.

## Delivery

Implement as independently reviewed TDD tasks on `feature/archive-capture-stabilization`. Run extension typecheck, lint, tests, Chromium build, Firefox build, Rust formatting, Clippy, and the full Rust test suite. Commit each reviewed task, merge the completed branch into `develop`, and remove the worktree.