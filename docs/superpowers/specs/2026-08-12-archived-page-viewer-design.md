# Archived Page Viewer Design

**Status:** Blocked — awaiting the capture spec
**Date:** 2026-08-12

> **Sequencing changed after approval.** The vault holds one captured page and
> no further captures will be made until this work is complete, so no corpus of
> raw-`outerHTML` snapshots will accumulate. The dual-path design below — content-type
> dispatch, the 415 seam, the unconditional low-fidelity notice — exists only to
> carry legacy snapshots that will now never exist.
>
> The capture spec is therefore promoted ahead of this one, and this document
> must be revised against its outcome before implementation. The revision hinges
> on one decision: if capture produces WACZ, the viewer needs server-side record
> unpacking; if it produces a single inlined self-contained HTML document, the
> viewer stays a sandboxed iframe over one blob and most of what follows survives
> unchanged.
>
> Sections that survive either way: the route and its placement, the sandbox
> headers and the four security invariants, the refusal to fetch from the live
> web, the typed-`archive`-metadata fix, and the banner.

## Summary

Clepsydra will gain a dedicated route for viewing the captured snapshot of an archived page, framed beneath a provenance banner in the manner of the Internet Archive's Wayback Machine. The banner states where the page came from and when it was captured; the frame renders the snapshot inertly, from captured bytes only.

The snapshot is served by a new endpoint that exists solely to be framed. It sets a `Content-Security-Policy: sandbox` so the archived markup runs in an opaque origin with no script execution and no reach into vault storage or the API. `/api/vault/cas/{hash}` is unchanged and continues to force download for active content types.

The viewer is designed against an artifact contract rather than a specific capture technology. Today every snapshot is `text/html`; when WACZ capture lands, the same route dispatches on content type and the rest of the viewer is unaffected.

## Goals

- Read an archived page's captured snapshot inside Clepsydra, with its origin URL and capture time visible.
- Serve archived markup inertly: no script execution, no access to the vault origin.
- Render only what was captured, never fetching from the live web.
- Keep the fidelity decision reversible — the viewer must not depend on how the snapshot was produced.
- Make the current low-fidelity state legible rather than disguised.
- Fix the untyped `[archive]` frontmatter so the banner reads typed fields.

## Non-goals

- WACZ unpacking, or any capture-side work. The route returns 415 for artifacts it cannot yet frame; filling that in belongs to the capture spec.
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

The only endpoint that serves archived markup inline. It looks the blob up in the CAS and dispatches on its stored content type:

- `text/html`, `application/xhtml+xml` — served inline with the sandbox headers below.
- anything else, including `application/wacz` — `415 Unsupported Media Type`, with a message naming the type. This is the seam where the capture spec plugs in.
- unknown hash — `404`.

### Response headers

```
Content-Security-Policy: sandbox; default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline' data:; font-src data:
X-Content-Type-Options: nosniff
Content-Type: <stored content type>
```

`sandbox` with no tokens gives an opaque origin and blocks script execution outright. `style-src 'unsafe-inline'` admits the page's own `<style>` blocks, which is not a meaningful vector once scripts cannot run.

**No directive permits `http:` or `https:`.** This is a correctness property, not only a safety one. Wayback serves what it captured; if the frame could fetch live assets, an old archive would silently render with today's images and would misrepresent what it recorded. Refusing live fetches also keeps the low-fidelity state visible instead of papered over.

## Server: typed archive metadata

`PageMetaResponse` gains an optional typed `archive` object mirroring the frontmatter table, so the banner reads generated types rather than untyped JSON. `PageMeta`'s serializer already emits these fields; only the OpenAPI mirror is missing them.

A parallel snapshot-metadata endpoint was considered and rejected: it would duplicate a lookup the page query already performs, and would leave the general untyped-frontmatter problem unfixed.

`ui/src/api/schema.d.ts` must be regenerated afterwards. Note that `bun run openapi` targets `localhost:3000`; regenerating against a server running an older binary silently produces a schema missing the new fields, which still typechecks. Regenerate against a server built from the working tree.

## Security invariants

Stated so tests can pin each one:

1. The view response carries `Content-Security-Policy: sandbox`.
2. No CSP directive in that response permits a network scheme.
3. The `<iframe>` also carries a bare `sandbox` attribute with **no tokens** — defence in depth, independent of the header. No tokens is the maximally restrictive form: markup and CSS still render, while scripts, forms, popups and same-origin access are all denied. In particular it must not gain `allow-scripts` or `allow-same-origin`; granting both together would let the framed page remove its own sandbox.
4. `/api/vault/cas/{hash}` still returns `Content-Disposition: attachment` for active content types.

Invariant 4 is the existing G1 regression guard. This design adds an inline path, so that guard becomes load-bearing: it is what confines inline rendering to the view route.

## States

| Condition | Rendering |
|---|---|
| Page has `archive.snapshot_hash`, blob is HTML | Banner plus framed snapshot, with a notice that external resources were not captured |
| Page has no `archive` metadata | Explanatory empty state and a link back to the page — reachable by typing the URL for any ordinary note |
| `snapshot_hash` present, blob absent from CAS | "Snapshot is no longer in the content store", naming the hash — the garbage-collected case |
| Blob type cannot be framed | The 415 message, naming the type |
| Page not found | Existing 404 handling |

The low-fidelity notice is **unconditional** for now. There is exactly one kind of snapshot today, so a `fidelity` frontmatter field would have a single possible value. When WACZ capture lands and there are genuinely two, the capture spec adds the field and the banner branches on it.

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
- No CSP directive permits `http:` or `https:`.
- Non-framable content type returns 415 naming the type.
- Unknown hash returns 404.
- `/api/vault/cas/{hash}` still returns `attachment` for active types (regression).

**Frontend**
- Banner renders origin URL, capture time and title from `meta.archive`.
- Optional provenance fields are omitted when absent, not blank.
- Iframe receives the correct `src` and a `sandbox` attribute.
- Each of the three empty/error states renders its explanation.

## Risks

**The frame will look bare.** Today's snapshot is raw `document.documentElement.outerHTML` with nothing inlined, so the sandbox blocks its stylesheets and images and the result is close to unstyled text. This is the honest rendering of what was captured, and the notice says so — but it means the viewer's value is limited until the capture work lands. Accepted deliberately: the alternative is a frame that lies.

**415 is a visible dead end** if a WACZ arrives before the capture spec is implemented. Acceptable because no WACZ can exist until that spec ships.

## Follow-up

The capture spec (fidelity: WACZ or inlined self-contained HTML) is the sequel and the thing that makes this viewer worth using. It fills in the 415 branch, adds the `fidelity` field, and carries the licence questions this design avoided — `single-file-core` and Browsertrix are both AGPL, and the JavaScript WACZ tooling terms need checking.
