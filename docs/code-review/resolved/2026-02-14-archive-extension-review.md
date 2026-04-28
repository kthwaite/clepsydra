# Code Review: Archive/CAS + Extension Stack

## Findings (ordered by severity)

1. Severity: `P1` | Benefit: `High` | Location: `src/vault/archive_hook.rs:29`, `src/vault/archive_hook.rs:34`, `src/api/archive.rs:316`, `src/api/archive.rs:327`, `extension/src/background/service-worker.ts:128`, `extension/src/background/service-worker.ts:157`  
Issue: snapshot blobs are ref-count decremented twice on page delete.  
Impact: the snapshot hash is stored both as `snapshot_hash` and inside `blobs`; delete hook decrements both paths, which can drive shared blobs to zero/negative refs and allow GC to delete still-referenced data.  
Suggested change: either exclude snapshot from `archive.blobs` metadata, or skip decrement in `archive_hook` when blob hash equals `snapshot_hash`; add an integration test for two pages sharing one snapshot hash, delete one, verify remaining blob is still retrievable.

2. Severity: `P1` | Benefit: `High` | Location: `src/vault/config.rs:123`, `src/vault/config.rs:129`, `src/vault/config.rs:131`, `src/api/archive.rs:185`, `src/api/mod.rs:43`  
Issue: archive safety config is defined but not enforced (`enabled`, `max_blob_size_mb`, `max_request_size_mb`).  
Impact: archive ingest remains active even when disabled, and request/blob size limits are ignored, creating a straightforward resource-exhaustion path.  
Suggested change: hard-gate ingest on `archive.enabled`, reject per-blob/request size violations before decode/store, and add tests for disabled mode and over-limit payloads.

3. Severity: `P1` | Benefit: `High` | Location: `src/api/archive.rs:225`, `src/api/archive.rs:275`, `src/api/archive.rs:348`, `src/api/archive.rs:355`, `src/vault/cas.rs:152`  
Issue: ingest is non-atomic; CAS writes happen before page path validation/write/indexing.  
Impact: if path validation or later file/index operations fail, blobs stay in CAS with positive `ref_count` and are never GC’d (`gc` only removes `ref_count <= 0`). This allows permanent orphan accumulation.  
Suggested change: use a transactional/compensating flow (track stored hashes and decrement on downstream failure), and move validation of target path earlier.

4. Severity: `P1` | Benefit: `Med` | Location: `src/api/archive.rs:84`, `src/api/archive.rs:86`, `src/api/archive.rs:88`  
Issue: `slugify` truncates using byte indexing on UTF-8 strings.  
Impact: long non-ASCII titles can panic on non-char boundaries, turning a user request into a handler crash path.  
Suggested change: truncate on `char_indices` or use a UTF-8-safe truncation helper; add regression test with long CJK/emoji title.

5. Severity: `P1` | Benefit: `Med` | Location: `extension/src/background/service-worker.ts:220`, `extension/src/popup/popup.ts:22`, `extension/manifest.v2.json:6`  
Issue: Firefox MV2 build path is inconsistent with runtime APIs (uses `chrome.scripting` but MV2 manifest doesn’t provide equivalent support).  
Impact: capture trigger path likely fails on Firefox despite “cross-browser” build config.  
Suggested change: either implement MV2-compatible script injection path or drop Firefox target until parity is real.

6. Severity: `P2` | Benefit: `Med` | Location: `tests/archive_test.rs:46`, `src/vault/archive_hook.rs:13`, `src/api/pages.rs:570`  
Issue: archive integration tests disable delete hooks, so CAS cleanup behavior is untested.  
Impact: the ref-count lifecycle bug above could ship undetected.  
Suggested change: add integration test with real `ArchiveDeleteHook` wired, then verify ref-count and blob accessibility before/after deletion.

## Open questions / assumptions

1. Is Firefox support a hard release requirement, or can it be explicitly deferred?
2. Should archive ingest accept arbitrary clients, or only trusted extension clients (affects strictness of size/validation/error-hardening)?

## Action plan

1. Fix ref-count lifecycle first (double-decrement + rollback on ingest failure) and add integration coverage.
2. Enforce archive config limits in handler/request layer.
3. Make `slugify` UTF-8-safe and add Unicode panic regression test.
4. Resolve Firefox compatibility claim (implement or remove).
