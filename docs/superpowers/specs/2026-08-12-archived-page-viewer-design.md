# Archived Page Viewer Design

**Status:** Approved design — implement after the capture spec
**Date:** 2026-08-12

> **Revised after the capture spec.** `2026-08-12-fidelity-capture-design.md`
> settles the artifact: one SingleFile snapshot per page, deconstructed into the
> CAS. Two consequences, applied below:
>
> - The dual-path content-type dispatch, the `application/wacz` 415 seam and the
>   unconditional low-fidelity notice are **removed**. There is one artifact, and
>   no corpus of raw-`outerHTML` snapshots will accumulate.
> - The CSP invariant becomes "no **external** origin" rather than "no network
>   scheme". Snapshot resources live at `/api/vault/cas/<hash>`, so the frame
>   needs an explicit allowance for the vault's own host.

## Summary

Clepsydra will gain a dedicated route for viewing the captured snapshot of an archived page, framed beneath a provenance banner in the manner of the Internet Archive's Wayback Machine. The banner states where the page came from and when it was captured; the frame renders the snapshot inertly, from captured bytes only.

The snapshot is served by a new endpoint that exists solely to be framed. It sets a `Content-Security-Policy: sandbox` so the archived markup runs in an opaque origin with no script execution and no reach into vault storage or the API. `/api/vault/cas/{hash}` is unchanged and continues to force download for active content types.

The snapshot is a SingleFile capture whose resources have been deconstructed into the content store and rewritten to `cas:` references, as specified in `2026-08-12-fidelity-capture-design.md`. The frame therefore loads its resources from the vault's own host and from nowhere else.

## Goals

- Read an archived page's captured snapshot inside Clepsydra, with its origin URL and capture time visible.
- Serve archived markup inertly: no script execution, no access to the vault origin.
- Render only what was captured, never fetching from the live web.
- Keep the viewer independent of how the snapshot was produced, beyond the artifact contract it consumes.
- Fix the untyped `[archive]` frontmatter so the banner reads typed fields.

## Non-goals

- Capture-side work of any kind. That is `2026-08-12-fidelity-capture-design.md`, which this spec depends on and must follow.
- Capture history, timelines, or multiple snapshots per URL. The data model holds one archive per URL and re-capturing changed content returns 409; that is unchanged here.
- Annotating, highlighting, or editing the framed page.
- Replaying dynamic behaviour (XHR, dynamic imports). That needs URL-rewriting replay, which this design deliberately declines.
- Changing the READER experience. The markdown body remains the primary way to read an archive.

## Existing architectural fit

Archived pages are created by `ingest_archive` in `src/api/archive.rs`. It writes a page whose frontmatter carries an `[archive]` table — `url`, `canonical_url`, `domain`, `captured_at`, `content_hash`, `snapshot_hash`, plus optional Readability provenance (`byline`, `site_name`, `published_time`, `lang`, `excerpt`) — and stores the captured HTML in the CAS under `snapshot_hash`.

`serve_blob` (`src/api/archive.rs`) serves CAS blobs. Since the archive hardening work it sends `Content-Security-Policy: sandbox; default-src 'none'`, `X-Content-Type-Options: nosniff`, and `Content-Disposition: attachment` for active content types, so archived HTML currently downloads rather than rendering. That is deliberate and stays.

Pages are read through `GET /api/vault/pages/{path}`, returning `PageDetail`. Its `meta` field serialises `PageMeta`, whose custom `Serialize` flattens `extra` — so the `archive` table *is* present in the response JSON. The OpenAPI mirror `PageMetaResponse` omits `extra` entirely, so the generated `ui/src/api/schema.d.ts` does not know those fields exist. The UI cannot read them type-safely today.

The frontend uses TanStack Router with file-based routes in `ui/src/routes/`. `routes/pages/$.tsx` is the existing splat-route precedent. `usePage(path)` in `ui/src/api/pages.ts` is the existing page-detail query.

## Route and placement

A dedicated full-page route, `ui/src/routes/archive.$.tsx`, keyed by **vault page path** rather than snapshot hash.

Keying by page path follows from one-capture-per-URL: the snapshot is an attribute of the page, not an independent entity. It also makes the query the existing `usePage(path)` with no new client plumbing, and makes returning to the folio a plain link.

The route is reached from the archived page's folio. It is not a folio tab mode: a full web page needs the whole window, and the workspace chrome earns nothing here.

## Server: the view endpoint

`GET /api/vault/archive/view/{hash}`

The only endpoint that serves archived markup inline. It looks the blob up in the CAS and serves it with the sandbox headers below.

Snapshots are always `text/html` — the capture pipeline produces exactly one artifact type. Any other stored content type is a corruption, not a format to support, and returns `415` naming the type. An unknown hash returns `404`.

### Response headers

```
Content-Security-Policy: sandbox; default-src 'none'; img-src <vault-origin> data:; media-src <vault-origin> data:; style-src 'unsafe-inline' <vault-origin> data:; font-src <vault-origin> data:
X-Content-Type-Options: nosniff
Content-Type: text/html
```

`<vault-origin>` is the server's own scheme and host, written explicitly. `'self'`
cannot be used: CSP `sandbox` gives the frame an opaque origin, against which
`'self'` matches nothing. The origin is derived from configuration, not from the
request's `Host` header, so a spoofed header cannot widen the policy.

`sandbox` with no tokens gives an opaque origin and blocks script execution outright. `style-src 'unsafe-inline'` admits the page's own `<style>` blocks, which is not a meaningful vector once scripts cannot run.

**No directive permits an external origin.** The frame reaches the vault's own host for deconstructed resources and nothing else. This is a correctness property, not only a safety one: Wayback serves what it captured, and a frame that could fetch live assets would render an old archive with today's images, misrepresenting what it recorded.

### Interaction with the CAS attachment rule

Deconstructed snapshots reference their resources at `/api/vault/cas/{hash}`, which forces `Content-Disposition: attachment` for active content types. Images, CSS and fonts are unaffected. **SVG is:** `image/svg+xml` is on the active list, because an SVG navigated to directly can execute script.

An SVG loaded through `<img>` cannot execute script, so the attachment header is not protecting anything in that position — but browsers vary in whether they honour `Content-Disposition` on subresources, so a snapshot's SVG assets may fail to render. The implementation must verify this against a real capture containing SVG, and if it breaks, the fix is to distinguish navigation from subresource loading (e.g. `Sec-Fetch-Dest`) rather than to drop the attachment rule.

## Server: typed archive metadata

`PageMetaResponse` gains an optional typed `archive` object mirroring the frontmatter table, so the banner reads generated types rather than untyped JSON. `PageMeta`'s serializer already emits these fields; only the OpenAPI mirror is missing them.

A parallel snapshot-metadata endpoint was considered and rejected: it would duplicate a lookup the page query already performs, and would leave the general untyped-frontmatter problem unfixed.

`ui/src/api/schema.d.ts` must be regenerated afterwards. Note that `bun run openapi` targets `localhost:3000`; regenerating against a server running an older binary silently produces a schema missing the new fields, which still typechecks. Regenerate against a server built from the working tree.

## Security invariants

Stated so tests can pin each one:

1. The view response carries `Content-Security-Policy: sandbox`.
2. No CSP directive in that response permits any origin other than the vault's own.
3. The `<iframe>` also carries a bare `sandbox` attribute with **no tokens** — defence in depth, independent of the header. No tokens is the maximally restrictive form: markup and CSS still render, while scripts, forms, popups and same-origin access are all denied. In particular it must not gain `allow-scripts` or `allow-same-origin`; granting both together would let the framed page remove its own sandbox.
4. `/api/vault/cas/{hash}` still returns `Content-Disposition: attachment` for active content types.

Invariant 4 is the existing G1 regression guard. This design adds an inline path, so that guard becomes load-bearing: it is what confines inline rendering to the view route.

## States

| Condition | Rendering |
|---|---|
| Page has `archive.snapshot_hash`, blob present | Banner plus framed snapshot |
| Page has no `archive` metadata | Explanatory empty state and a link back to the page — reachable by typing the URL for any ordinary note |
| `snapshot_hash` present, blob absent from CAS | "Snapshot is no longer in the content store", naming the hash — the garbage-collected case |
| Stored blob is not `text/html` | The 415 message, naming the type — a corruption, not an expected state |
| Page not found | Existing 404 handling |

## Banner content

Origin URL (linked to the live page), capture time, page title, and a link back to the vault page. Where present, `site_name`, `byline` and `published_time` are shown; they are absent on archives captured before that metadata was retained, and the banner omits them rather than showing placeholders.

## Components

**Server** (`src/api/archive.rs`)
- `view_snapshot` handler.
- `framable_content_type(&str) -> bool`, the counterpart to the existing `is_active_content`.
- `sandbox_headers()` returning the header set above.
- `ArchiveMetaResponse` DTO on `PageMetaResponse`.

**Frontend**
- `ui/src/routes/archive.$.tsx` — route, states, iframe.
- `ui/src/components/codex/ArchiveBanner.tsx` — provenance chrome.
- A link into the route from the archived page's folio.

## Data flow

```
/archive/<vault path>
  └─ usePage(path)                    → PageDetail
       └─ meta.archive                → banner fields
       └─ meta.archive.snapshot_hash  → iframe src
            └─ GET /api/vault/archive/view/{hash}
                 └─ CAS lookup → dispatch on content type
                      └─ sandboxed bytes
```

## Testing

**Rust**
- View route sets `sandbox` CSP and serves HTML inline.
- No CSP directive permits an origin other than the vault's own.
- The allowed origin comes from configuration, not the request `Host` header.
- An unexpected stored content type returns 415 naming the type.
- Unknown hash returns 404.
- `/api/vault/cas/{hash}` still returns `attachment` for active types (regression).

**Frontend**
- Banner renders origin URL, capture time and title from `meta.archive`.
- Optional provenance fields are omitted when absent, not blank.
- Iframe receives the correct `src` and a `sandbox` attribute.
- Each of the three empty/error states renders its explanation.

## Risks

**Ordering.** This spec is worthless before the capture spec ships: framing a raw-`outerHTML` snapshot yields unstyled text with its resources blocked. Implement capture first.

**The allowed origin is a widening of the sandbox.** Permitting the vault's own host for subresources is what makes deconstructed snapshots render, but it means the frame can issue requests to our server. Those requests are limited to fetch directives — no script, no form, no navigation — and `/api/vault/cas/{hash}` is a read-only blob endpoint. Worth restating whenever the CSP is touched, because loosening it further is how this becomes a hole.

**Dependency.** `2026-08-12-fidelity-capture-design.md` — the artifact this frames, the `cas:` rewriting that requires the origin allowance, and the AGPL note about `single-file-core`.
