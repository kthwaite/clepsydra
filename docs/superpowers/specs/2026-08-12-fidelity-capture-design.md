# Fidelity Capture Design

**Status:** Approved design
**Date:** 2026-08-12

## Summary

The browser extension will capture a genuine self-contained snapshot of the page using SingleFile, alongside the existing Readability extraction. The snapshot's inlined resources are deconstructed server-side into the content store, so an archived page holds markdown for reading and a resource-referencing HTML document for fidelity.

Today's snapshot is `document.documentElement.outerHTML` with nothing inlined — a bag of dangling URLs that renders as an unstyled skeleton once the origin changes. This design replaces it. It also removes the extension's own resource-fetching, which existed only to compensate for the missing archiver.

Capture stays in the browser, because a personal vault archives paywalled and authenticated pages and only the browser has that session.

## Goals

- Store a snapshot that still renders after the origin site changes or disappears.
- Keep the Readability → markdown workflow as the primary reading surface, unchanged.
- Store snapshot resources in the CAS, deduplicated across pages, referenced by `cas:` rather than inlined.
- Give the viewer something worth framing.
- Reduce the extension: one resource pipeline, owned by the server.

## Non-goals

- WARC or WACZ. See "Artifact choice" below.
- Server-side or headless capture. Rejected for this iteration because it cannot reach authenticated pages.
- Replaying dynamic behaviour. SingleFile freezes the post-JS DOM; XHR-driven interaction is not preserved and will not be.
- PDF capture. gwern handles PDFs on a separate wget+OCR path; out of scope here.
- Per-URL archiving policy (domain exclusions, delayed capture). Worth having later; not this spec.
- Capture history. One archive per URL, unchanged.

## Artifact choice

Self-contained HTML produced by SingleFile, with resources deconstructed into the CAS.

The earlier analysis (`docs/design-notes/2026-08-12-extension-vs-singlefile.md`, Appendix A) proposed WACZ. That recommendation is superseded by evidence from `gwern.net`, the closest analogue to this system: `build/linkArchive.sh` drives SingleFile via Docker, with the parenthetical *"(ArchiveBox didn't work out)"* — ArchiveBox being WARC-based. `build/LinkArchive.hs` states the rationale: a self-contained static copy "which cannot linkrot", "faster for the reader to load & browse", capturing "the final DOMs saved using adblock".

What this forecloses: the real HTTP exchange — status, response headers, redirect chain — and third-party replay. A WACZ can be generated later from stored artifacts, but headers never recorded cannot be reconstructed. Accepted deliberately.

gwern also deconstructs any capture over 5 MB (`deconstruct_singlefile.php`), because a monolithic `data:`-URI document forces the reader to download everything to see anything, and base64 adds roughly a third. His asset directory is our CAS, so we deconstruct unconditionally and additionally get cross-page deduplication.

## Licence

`single-file-core` is AGPL-3.0-or-later. Clepsydra carries no `LICENSE` file and no `license` field in `Cargo.toml` or either `package.json`; it is private and unconveyed, so AGPL's obligations do not attach. **If the extension is ever published, it must be AGPL-3.0-or-later.** Recorded here so the decision is not rediscovered later.

## Pipeline

**Content script** (`extension/src/content/capture.ts`) — has a real DOM, which is where SingleFile is designed to run:

1. SingleFile over the live DOM → self-contained HTML, with `saveOriginalURLs` enabled.
2. Readability over the same DOM → article HTML and provenance, as today.

Both come from one page visit, so they cannot disagree about what the page was.

**Service worker** — a courier:

3. Turndown over the article HTML → markdown, with image URLs left as **original URLs**, not `cas:`.
4. POST the manifest: markdown, snapshot HTML, and metadata.

**Server** (`clep`) — sole owner of resource identity:

5. Decode the snapshot's `data:` URIs, store each as a CAS blob, rewrite the snapshot to `cas:<hash>`.
6. Rewrite the markdown's resource URLs through the same map, joining on the original URLs SingleFile recorded.
7. Store the deconstructed snapshot as a blob; write the page.

`saveOriginalURLs` is load-bearing: without it, inlining discards the URL that joins a markdown image to the blob the server just stored.

## Ownership

One component owns the resource map, and it is the server. Previously the extension fetched, hashed and rewrote; the server stored. Splitting that let the markdown and the snapshot disagree about what they referenced. After this change the markdown and snapshot are rewritten from a single map in a single place.

## Removed from the extension

- `fetchRemoteImages` and `remote-resources.ts`, with its tests
- `extractDataUris` and `resource-extractor.ts`, with its tests
- `MAX_REMOTE_IMAGES`, the per-resource and total size budgets, the skipped-resource accounting and the "N resources could not be archived" note

All of it compensated for the absent archiver: a regex over `<img src>` in the Readability output, capped at 50, blind to `srcset`, `<picture>`, and CSS backgrounds. SingleFile captures those properly. Net, the extension shrinks despite gaining SingleFile.

Retained unchanged: the capture queue, service-worker keepalive, per-request timeouts, injection-failure reporting and badge phases. SingleFile makes captures slower, so these matter more, not less.

## Hashing

`content_hash` currently serves two purposes that this change separates:

- **`content_hash`** — over the final stored markdown, after rewriting. Archived bodies are write-protected (`Kind::readonly_by_default` in `src/vault/kind.rs`, `body_is_protected` in `src/vault/page.rs`) on the stated grounds that this hash describes the stored body. It must therefore be computed post-rewrite, or that justification fails.
- **`source_hash`** — over the markdown as captured, before rewriting. Change detection keys on this, so a re-encoded image does not read as "the page changed".

The request's declared `content_hash` remains a transport integrity check over what the extension sent, verified as today. The server then computes both stored hashes itself.

Duplicate detection (`find_by_archive_url`) compares `source_hash`. The 409 conflict path is otherwise unchanged.

## Size limits

A media-heavy capture runs to tens of megabytes and base64 adds a third. The current defaults — `max_blob_size_mb` 50, `max_request_size_mb` 100 — were sized for a handful of images.

New defaults: **`max_blob_size_mb` 100**, matching gwern's per-resource cap (`--max-resource-size 100`), and **`max_request_size_mb` 250**, which accommodates a page carrying several large resources plus base64 overhead. SingleFile is configured with a matching per-resource limit so it declines oversized resources at capture time rather than producing a payload the server will reject.

`DefaultBodyLimit` in `archive_router_with_limit` must track `max_request_size_mb`; it already does, but the default passed by `router()` is a separate hardcoded 100 MB and must be raised with it.

A capture exceeding the limit fails the whole archive rather than degrading, because a snapshot missing arbitrary resources is not a snapshot. This is a deliberate reversal of the previous skip-and-continue behaviour, which was right for a best-effort image scrape and wrong for an archive.

## Capture hygiene

Adopted from `gwern.net/build/linkArchive.sh`, where each encodes a failure actually encountered:

- Reject a capture under 1 KB as corrupt.
- Reject a capture whose text matches known error-page strings despite HTTP 200: `403 Forbidden`, `404 Not Found`, `Access Denied`, `Download Limit Exceeded`, rate-limit notices, `Token is required`.
- Set SingleFile's `blockScripts` conditionally for sites whose own JS destroys the snapshot after load. gwern fingerprints the response for Substack markers rather than matching domains, because Substack is widely used under custom domains.
- Enable `loadDeferredImages` with a tall viewport and a network-idle wait, so lazy-loaded images resolve. gwern uses `--browser-height 10000`, `--browser-wait-until networkIdle`, `--load-deferred-images-max-idle-time 3000`.

## Frontmatter

`archive.snapshot_hash` points to the deconstructed snapshot. Added: `archive.source_hash` and `archive.resource_count`. The Readability provenance fields (`byline`, `site_name`, `published_time`, `lang`, `excerpt`) are unchanged.

## Consequence for the viewer

The viewer spec (`2026-08-12-archived-page-viewer-design.md`) is unblocked by this one and must be revised:

- Its dual-path content-type dispatch, the `application/wacz` 415 seam and the unconditional low-fidelity notice all disappear. There is one artifact.
- Its CSP invariant changes from "no network scheme" to "**no external origin**". Snapshot resources are served from `/api/vault/cas/<hash>`, so the frame needs an explicit allowance for the vault's own host; `'self'` will not work, because CSP `sandbox` gives the frame an opaque origin. Scripts stay blocked and the live web stays unreachable, which is what the rule protects.

## Testing

**Extension**
- The content script produces a snapshot containing no `http:`/`https:` resource references.
- Original URLs survive into the snapshot for the server to join on.
- Markdown retains original image URLs, not `cas:`.
- A capture under 1 KB, or matching an error-page string, is rejected before upload.

**Server**
- Deconstruction extracts every `data:` URI into a blob and rewrites the snapshot to `cas:`.
- Identical resources across two archives store one blob (dedup regression).
- Markdown image URLs are rewritten via the same map; an unmatched URL is left intact rather than silently dropped.
- `content_hash` matches the stored body; `source_hash` matches the captured markdown.
- Re-capturing with a re-encoded image but unchanged text does not 409.
- A capture over the size limit fails cleanly, leaving no orphaned blobs (the existing rollback path).

## Risks

**Capture is slow and heavy.** SingleFile drives the page, waits for network idle, and forces lazy images. Captures will take seconds to tens of seconds and produce large payloads. The existing queue, keepalive and timeouts were built for this; they now become load-bearing rather than precautionary.

**Fail-closed on size may be annoying.** Some pages will simply refuse to archive. That is the correct failure for an archive, but it needs a clear message naming the limit, or it will read as a bug.

**Snapshot rewriting is new server code operating on untrusted HTML.** It parses attacker-authored markup to extract and rewrite URLs. It must not execute anything, and its output is still served under the viewer's sandbox — but the parser itself is a new surface and should be treated as such.
