# Browser Extension vs SingleFile — Feature Parity Analysis

**Date:** 2026-08-12

**Compared:** `extension/` (Clepsydra Web Archive v0.1.0, ~700 LOC) against
[SingleFile](https://github.com/gildas-lormeau/SingleFile) v1.2.4 / `single-file-core` 1.5.84
(checked out at `../SingleFile`, HEAD `32931059`).

## Executive verdict

The two projects only *look* like they overlap. SingleFile is a **page-fidelity engine** with a
save-target plugin layer bolted on. Our extension is a **vault-ingest client** with a page-fidelity
placeholder where the engine should be.

The single most consequential finding: the field named `singlefile_html` contains no SingleFile
output. `extension/src/content/capture.ts:31-32` is literally

```ts
// TODO: integrate single-file-core library for faithful archive
const singlefile_html = document.documentElement.outerHTML;
```

`outerHTML` retains *references* to external CSS, images, fonts, and iframes rather than inlining
them, and omits shadow roots, canvas bitmaps, and cross-origin frame content entirely. We hash that
string, store it in CAS as `text/html`, and the reader-mode fallback path
(`service-worker.ts:203-215`) tells the user to "View the archived HTML snapshot" at `cas:<hash>`.
That snapshot is not an archive — it is a bag of dangling URLs that will render as an unstyled
skeleton the moment the origin site changes or goes away. This is the one gap where SingleFile is
not merely nicer; it is the entire reason SingleFile exists.

Conversely, we have one capability SingleFile does not: **semantic extraction into a knowledge
vault** — Readability → Turndown → markdown with `cas:` image rewriting, content-hash dedup,
auto-tagging, and CAS blob dedup on the server. SingleFile's markdown story is nonexistent; its
"save to MCP" target (`src/lib/mcp/mcp.js`) just writes an HTML file over JSON-RPC.

So: adopt SingleFile's capture engine and its operational guards. Do not adopt its product surface.

## Comparative matrix

Legend: **Strong** — broad, integrated · **Present** — shipped but narrower · **Partial** —
meaningful but missing a layer · **None** — absent

| Dimension | SingleFile | Clepsydra extension | Verdict |
|---|---|---|---|
| Self-contained HTML snapshot | Strong (`single-file-core`) | **None** (raw `outerHTML`) | **Critical gap** |
| Lazy/deferred image loading | Strong (`loadDeferredImages`, scroll + 1500 ms idle) | None | **Critical gap** |
| Shadow DOM capture | Strong (`shadowEnabled`) | None | Gap |
| Cross-origin iframe capture | Strong (`frame-tree`, `removeFrames`) | None | Gap |
| Canvas / video-poster serialization | Present (CORS-limited) | None | Gap |
| CSS pruning (unused styles/fonts) | Strong | N/A (no CSS captured) | Follows from above |
| Resource discovery | Full CSS/DOM walk | `<img src>` regex only (`service-worker.ts:80`) | **Gap** |
| Markdown extraction | None | Strong (Readability + Turndown) | **Our advantage** |
| Content-addressed dedup | `groupDuplicateImages` (in-document) | Strong (server-side CAS, cross-page) | **Our advantage** |
| Vault semantics (tags, path, frontmatter) | None | Strong | **Our advantage** |
| Save targets | Strong (disk, GDrive, Dropbox, WebDAV, S3, GitHub, REST, MCP, clipboard, share) | One (our API) | Intentional |
| Concurrency control | Strong (task queue, `maxParallelWorkers`) | **None** | **Guard gap** |
| Cancellation | Strong (`cancelTask`, `cancelAllTasks`, badge toggle) | None | QoL gap |
| Progress feedback | Strong (in-page bar, logs panel, badge state machine) | End-of-run notification only | QoL gap |
| Network timeout | `networkTimeout` option | **None** (unbounded `fetch`) | **Guard gap** |
| Resource size cap | `maxResourceSize` (client-side) | Server-side only (`archive.rs:253-278`) | Guard gap |
| Referrer retry on 401/403/404 | Strong (`passReferrerOnError`, `fetch.js:80-96`) | None — silent drop | Guard gap |
| Per-URL rules / profiles | Strong (`regexp:` rules, named profiles) | None | Affordance gap |
| Multi-tab / batch / selected-links save | Strong | None | Affordance gap |
| Auto-save on load/unload | Strong | None | Affordance gap |
| Bookmark-triggered archive | Strong (`saveCreatedBookmarks` + folder filters) | None | **High-value affordance** |
| Save selection / save frame | Strong (context menu) | None | Affordance gap |
| Conflict policy | 4 modes (skip/uniquify/overwrite/prompt) | Setting exists, **is never read** | **Dead code** |
| Filename/path templating | Strong (~25 variables, `%if-empty<>`) | Server-side slug only | Affordance gap |
| Options import/export | Present | None | QoL gap |
| i18n | Strong (`_locales`) | None | Won't fix |
| Archived-HTML CSP hardening | `insertMetaCSP: true` (default on) | **None** | **Security gap** |

## Critical gaps

### 1. The snapshot is not a snapshot

Everything else in this document is secondary. Options, in order of increasing effort:

- **Vendor `single-file-core`** (npm `single-file-core@1.5.84`, AGPL-3.0-or-later). It is designed
  to be embedded — `src/index.js` in SingleFile is a 15-line shim over
  `globalThis.singlefile.getPageData(options, { fetch, frameFetch }, doc, win)`. We would replace
  `capture.ts`'s `outerHTML` line with a `getPageData` call and keep the rest of the pipeline
  unchanged, since it already consumes a single HTML string.
  **Licence caveat:** AGPL is a real constraint. It is fine for a personal extension we do not
  distribute; it becomes a question if the extension is ever published alongside the MIT-ish rest
  of the repo. Confirm intent before vendoring.
- **Interoperate instead of vendoring**: SingleFile already ships a REST save target
  (`src/lib/rest-form-api/index.js`, options `saveToRestFormApiUrl` / `…FileFieldName` /
  `…UrlFieldName` / `…Token`) and an MCP save target. We could accept a multipart POST at
  `/api/vault/archive/singlefile` and let stock SingleFile do the capture, then run
  Readability/Turndown **server-side** over the uploaded HTML. This sidesteps AGPL linkage
  entirely and is probably the cheapest path to a faithful archive.
- **Minimum viable fidelity** if neither: at least inline stylesheets and `<img>` bytes into the
  snapshot before hashing, and run the deferred-image scroll pass (below).

### 2. Lazy-loaded images are captured as placeholders

We snapshot synchronously. On any site using `loading="lazy"`, IntersectionObserver, or
`data-src` swapping, the images below the fold are 1×1 GIFs or absent, and the reader-mode markdown
inherits those. SingleFile's `loadDeferredImages` scrolls the document, dispatches scroll events
(`loadDeferredImagesDispatchScrollEvent`), waits `loadDeferredImagesMaxIdleTime: 1500`, and can
block cookies/storage during the pass to avoid tripping paywall counters. This is a self-contained,
~100-line behaviour that is worth porting even if we do nothing else on this list.

### 3. Resource discovery is a regex over `<img src>`

`IMG_SRC_REGEX` (`service-worker.ts:80`) misses `srcset`, `<picture><source>`, `<video poster>`,
inline `<svg>`, and CSS `background-image`. `MAX_REMOTE_IMAGES = 50` then silently truncates
whatever it did find, with no record in the manifest that truncation occurred. At minimum, log the
drop count into the page frontmatter so an archive is never silently partial.

## Guards worth adopting

Ordered by risk.

### G1 — Archived HTML is served same-origin with no CSP *(security)*

`serve_blob` (`src/api/archive.rs:433-443`) echoes the stored `content_type` verbatim. We upload the
page snapshot as `text/html` (`service-worker.ts:184-188`). A `grep` for `Content-Security-Policy`
across `src/` returns nothing. So `GET /api/vault/archive/cas/<hash>` returns attacker-authored HTML
and JavaScript, executing **on the vault's own origin**, with access to the vault UI's storage and
the unauthenticated `/api/vault/*` surface.

SingleFile's mitigation is `insertMetaCSP: true` (on by default) — it injects a restrictive CSP
`<meta>` into every saved page. Ours should be stronger, since we control the server:

- Send `Content-Security-Policy: sandbox; default-src 'none'` on blob responses, plus
  `X-Content-Type-Options: nosniff`.
- Or serve blobs from a distinct origin/port, or force `Content-Disposition: attachment` for
  `text/html`, and render archived pages only inside a sandboxed iframe.

This is worth fixing regardless of the rest of this document.

### G2 — No in-flight task registry *(correctness)*

`chrome.runtime.onMessage.addListener` fires `void processCaptureResult(message)` and returns
`undefined` synchronously (`service-worker.ts:305-318`). Two consequences:

1. Pressing `⌘⇧S` twice, or clicking Capture on two tabs, runs the whole pipeline concurrently with
   no dedup — N base64-encoded uploads racing to the same URL, resolved arbitrarily by the server's
   409 logic.
2. **The MV3 service worker can be terminated mid-flight.** Nothing holds the worker alive: the
   listener returned `undefined`, so there is no open message port. A slow image fetch or a large
   upload can be killed with no notification and no retry. This is the single most likely cause of
   "I pressed the shortcut and nothing happened".

SingleFile's `business.js` is the reference design: a `tasks[]` array with
`pending`/`processing` states, `maxParallelWorkers`, `runTasks()` back-pressure, per-task
`cancel()`, `isSavingTab()` for the badge toggle, and `onTabReplaced` to survive tab swaps. We do
not need all of it — a keyed map of in-flight captures plus a `chrome.runtime.connect` keepalive
port would close both holes.

### G3 — Unbounded image fetches *(availability)*

`await Promise.all(imageSources.map(...))` with a bare `fetch` (`service-worker.ts:144`) and no
`AbortController`. One hanging CDN stalls the entire capture forever, and since the worker may be
killed first (G2), the user sees nothing at all. Adopt SingleFile's `networkTimeout` as an
`AbortSignal.timeout()` per resource, plus a global capture deadline.

### G4 — Silent drop on 403 *(fidelity)*

Hotlink-protected images 403 from the service worker because the request carries no `Referer`. We
`return null` and move on. SingleFile retries with a tagged request id and injects the original
referrer via a webRequest/DNR rule (`src/lib/single-file/fetch/bg/fetch.js:80-96`, gated by
`passReferrerOnError`). Cheap version for us: retry once from the *content script* context, where
the browser attaches the correct referrer automatically.

### G5 — No client-side size pre-check *(UX)*

The server rejects oversized payloads with a 400 (`archive.rs:253-278`); the extension surfaces the
raw body text via `showNotification("Archive Failed", String(err))`. The whole capture is lost
because of one large hero image. SingleFile's `maxResourceSize` skips oversized resources and saves
the page anyway. Mirror the server's `max_blob_size_mb` / `max_request_size_mb` client-side and
degrade gracefully rather than failing the capture.

### G6 — Injection failures are invisible *(UX)*

`popup.ts:41-48` calls `executeCaptureScript(tab.id)` and then `window.close()` immediately. On
`chrome://`, `about:`, the Web Store, or a PDF viewer, `chrome.scripting.executeScript` rejects —
unhandled, popup already gone, zero feedback. SingleFile has an explicit `onForbiddenDomain(tab)`
path that paints a 🛇 badge with a "blocked" tooltip. Minimum: await the injection, catch, and show
a notification.

### G7 — Dead settings *(hygiene)*

- `on_content_changed` (`types.ts:42`) is written by the options page and **never read** by the
  capture path — already documented as a known issue in `extension/README.md`. SingleFile's
  `filenameConflictAction` (`skip` / `uniquify` / `overwrite` / `prompt`) is a clean model to
  implement against; the server already returns 409 with detail.
- `api_key` (`types.ts:37`) is never sent by `ClepsydraClient` and — worse — `options.ts:29-46`
  rebuilds the settings object without it, so any value would be silently erased on save.
- `archive_path_prefix` (`types.ts:39`) is hardcoded back to `"archive"` at `options.ts:36`.

Either wire these up or delete them; right now they are three traps.

## QoL affordances worth stealing

**High value for a PKM, ordered by payoff:**

1. **Bookmark-triggered archive** — SingleFile's `saveCreatedBookmarks` with
   `allowedBookmarkFolders` / `ignoredBookmarkFolders` / `replaceBookmarkURL`
   (`src/core/bg/bookmarks.js`). "Bookmark into a folder → page lands in the vault" is a near-perfect
   fit for our model and requires no UI beyond a folder allowlist.
2. **Batch URL ingest** — `src/ui/pages/batch-save-urls.html` plus `saveUrls()`: paste a list, each
   URL opens in a background tab, captures, and auto-closes. This is the backfill tool for turning
   an existing read-later queue into vault pages.
3. **Save selected links** — select links on a page, archive all of them (`saveSelectedLinks`).
   Natural for capturing a bibliography or a link roundup.
4. **Per-URL rules** — SingleFile's `getRule` matches `regexp:`-prefixed patterns to named profiles.
   For us the payoff is different but larger: per-domain **default tags, page kind, and target
   folder**, so `arxiv.org` captures land differently from `news.ycombinator.com`.
5. **Progress + cancel** — badge state machine (`ui-button.js:53-110`: `default` / `inject` /
   `execute` / `progress` / `end` / `error` / `forbidden`) and the pendings page
   (`src/ui/pages/pendings.html`). Even just badge text + a cancel entry would remove most of the
   "did that work?" ambiguity.
6. **Multi-tab capture** — highlight N tabs, click once, all are queued. Falls out of G2's task
   queue almost for free.
7. **Auto-save on unload** — `autoSaveUnload` / `autoSaveLoadOrUnload` / `autoSaveRepeat`. Archives
   what you actually read rather than what you remembered to press a key on. Needs a rules layer
   (item 4) first or it will flood the vault.

**Lower value, cheap:**

- Options **export/import** as JSON (SingleFile's profile export) — a 20-line addition that makes
  the extension reproducible across browsers, and works around our unconditional use of
  `chrome.storage.sync`. SingleFile picks `sync` vs `local` at runtime (`config.js:284-290`); we
  should too, since `storage.sync` has an 8 KB-per-item quota that a long default-tag list can hit.
- **Configurable shortcut** (`customShortcut`) instead of hardcoded `⌘⇧S` in `manifest.json:24-28`.
- **Delay before processing** (`delayBeforeProcessing`) for SPAs that need a beat to settle.
- **`saveOriginalURLs`** — record the pre-rewrite resource URLs. We rewrite images to `cas:` hashes
  and lose the provenance; worth carrying in frontmatter.

## Explicitly not worth adopting

- The nine save targets (GDrive, Dropbox, WebDAV, S3, GitHub, REST, MCP, clipboard, Web Share). We
  have exactly one destination by design.
- The in-page annotation editor (`src/ui/pages/editor.html`, ~2 MB of bundle). Annotation belongs in
  the vault UI, over the markdown, not over the HTML snapshot.
- Woleet blockchain proof (`addProof`), self-extracting archives, zip compression, password
  encryption. Orthogonal to a local single-user vault.
- i18n / `_locales`.
- Profile management as a first-class concept. We want *rules* (per-URL tags/kind), not
  user-switchable profiles.

## Recommended sequence

1. **G1** — CSP/sandbox on `serve_blob`. Independent of everything else, and it is a live
   same-origin script-execution hole. *(server-side, small)*
2. **G7** — delete or wire the three dead settings. *(tiny, removes traps)*
3. **G2 + G3 + G6** — task registry, keepalive port, per-resource timeout, injection-failure
   feedback. These are one coherent piece of work on the service worker. *(medium)*
4. **Decide the fidelity strategy** (§ Critical gap 1). Recommendation: **server-side ingest of a
   stock-SingleFile capture** via the REST target, which avoids AGPL linkage and gets us a genuine
   archive without reimplementing the engine. Port `loadDeferredImages` regardless, since our
   Readability pass runs in-page and benefits from it directly. *(large)*
5. **Rules layer + bookmark trigger + batch ingest** — the three affordances with the highest
   vault-specific payoff. *(medium each, sequential)*

---

## Appendix A — Is WARC worth adopting as the storage medium?

**Verdict: not as a replacement for CAS, but yes as the thing one CAS blob contains.**

The question decomposes into two that have opposite answers: *what is the storage medium* (WARC is a
poor fit) and *what is the archival artifact* (WARC/WACZ is clearly better than the raw `outerHTML`
we ship today).

### What WARC would buy

- **Provenance we currently discard.** CAS stores bytes plus a content-type string the extension
  guesses from `response.headers.get("content-type")?.split(";")[0] || "application/octet-stream"`
  (`service-worker.ts:148`). WARC preserves the actual request/response records: status line, full
  response headers, redirect chain, served MIME, capture timestamp.
- **Replay of dynamic pages — and this is exactly the gap in § Critical gap 1.** Inlining (the
  SingleFile approach) fundamentally cannot capture runtime `fetch`/XHR/dynamic import; it freezes a
  DOM. URL-rewriting replay (pywb, replayweb.page) serves the original URL space back to the page,
  so JS-heavy sites actually work on replay. The difference between a screenshot and a recording.
- **An exit hatch.** WARC is the archival lingua franca — wget, Browsertrix, ArchiveBox, IA,
  replayweb.page. For a vault whose ethos is "plain files that outlive the tool", a bespoke
  CAS+markdown archive is the one part that does not.
- **Signing.** WACZ's `datapackage-digest.json` is a standard answer to the provenance itch that
  SingleFile scratches with its woleet `addProof` option.

### Why it is wrong as *the* storage medium

- **Deletion and GC regress.** `src/vault/cas.rs` gives refcounted blobs (`increment_ref` /
  `decrement_ref`, lines 146-166) plus an age-gated `gc` (line 167). WARC is append-only by design;
  deleting one archived page means rewriting a WARC or leaving tombstones, and `revisit` dedup
  records create inter-file dependencies that block compaction. Wrong shape for a vault where pages
  are deleted and refiled constantly.
- **We would rebuild CAS on top of it anyway.** WARC has no random access; it needs a CDXJ index
  mapping digest → (file, offset, length). That lands in SQLite, and every image render becomes
  seek + gunzip + strip-HTTP-headers. That is the CAS lookup we already have, plus a container,
  plus a third authoritative store that is not greppable — against the "markdown/TOML
  authoritative, SQLite derived" principle.
- **Size.** WARC captures everything the browser fetched as served — ads, analytics, webfonts.
  Roughly 5-50 MB per article against markdown plus a few images today.

### The shape that fits: WACZ-in-CAS

Store **one WACZ per archived page as a single CAS blob**. WACZ is a ZIP of `warc.gz` + CDXJ index
+ `pages.jsonl` + `datapackage.json`, replayable entirely client-side by replayweb.page (service
worker + WASM, no server component).

This buys everything above while changing almost nothing:

- CAS remains the storage medium. The WACZ is content-addressed, deduped, refcounted and GC'd like
  any other blob. No new store, no new lifecycle.
- Markdown and inline images keep coming from the Readability/Turndown path as individual blobs, so
  grep and UI rendering are untouched.
- `cas:<hash>` of the WACZ becomes the faithful-snapshot link, opened in an embedded replay viewer.
- **It closes G1 for free.** We stop serving attacker-authored `text/html` from the vault origin
  entirely — the blob is `application/zip` and the replay engine sandboxes the content itself. The
  security finding evaporates rather than needing a CSP patch.

### The catch is capture, not storage

Producing a genuine WARC needs response headers *and* bodies, which is what extension APIs withhold:

- **Chrome MV3**: `chrome.webRequest` has never exposed response bodies. The only route is
  `chrome.debugger` (CDP `Network.getResponseBody`), which needs the `debugger` permission and shows
  a persistent "is debugging this browser" banner on every capture. This is what Webrecorder's
  ArchiveWeb.page does, and it is a heavy ask.
- **Firefox MV2** — which we already build (`extension/manifest.v2.json`) — has
  `webRequest.filterResponseData`, which *can* read bodies. The Firefox build could do this without
  the banner.
- **Server-side** (`clep` driving headless Chrome → WACZ) avoids the permission problem but loses
  the authenticated session, and paywalled or logged-in pages are precisely what is worth archiving.

### Recommendation

1. **Do not move CAS to WARC.** The refcount + GC model is right for a mutable vault.
2. **Add WACZ export now**, built from what we already store. No capture changes, cheap, and it is
   the exit hatch. Worth doing independently of any fidelity work.
3. **If the fidelity work happens** (§ Critical gap 1), emit WACZ stored as one blob rather than
   inventing a self-contained-HTML format. Same effort, standard output, retires G1.

**Open question before committing:** licences. Browsertrix Crawler is AGPL; the terms on the
JavaScript WACZ/warcio tooling need verifying. Same constraint that complicates vendoring
`single-file-core`.

---

## Appendix B — A distraction-free reader for captured pages

**Scope:** a reading surface for *archived web pages*. Not a read mode for ordinary vault pages —
that is a separate, unrelated UI concern.

### We already built this, for a different subsystem

`ui/src/main.css:943-992` is a complete reading stylesheet, tokenised into Vessel (`--ink`,
`--ink-2`, `--accent`, `--highlight`, `--font-sans`): measure, 1.65 leading, heading scale, link
treatment, media clamped to `max-width: 100%`. `FeedReaderPane` renders `entry.content_html` into it
via `dangerouslySetInnerHTML`, which is safe because `src/feeds/fetch.rs:248` runs `ammonia::clean`
at ingest under a size cap, with tests asserting scripts and event handlers are stripped
(`fetch.rs:760-768`).

The feeds subsystem therefore does the right thing end to end: **sanitize untrusted remote HTML on
the way in, render it in a purpose-built reading surface.** The archive subsystem ingests the same
category of content and reuses none of it — it stores raw `outerHTML`, and
`ui/src/lib/resourceUrl.ts:17-22` maps `cas:` links to `{ kind: "browser", href:
"/api/vault/cas/<hash>" }`, so the fallback markdown's "View the archived HTML snapshot" link
navigates the top-level context straight into unsanitized page HTML on the vault origin.

That is G1 with a live trigger, and the remedy already exists twelve files away. This is not a new
feature; it is converging two subsystems that ingest the same thing.

### Three tiers

| Tier | Artifact | Purpose | Status |
|---|---|---|---|
| Fidelity | WACZ blob in CAS, sandboxed replay | proof of what was served; rarely opened; large | broken (raw `outerHTML`) |
| **Reader** | ammonia-sanitized Readability HTML, `cas:`-rewritten images | **what you actually open** | **missing** |
| Semantic | markdown body in the vault page | FTS5, wikilinks, block refs, Slate editing, git | shipped |

### Does the reader tier earn its place over markdown?

Archived pages already render as ordinary vault pages through `MarkdownRenderer`, so a reading
surface of sorts exists. The question deserves an honest answer rather than advocacy.

What markdown loses, given our actual converter — `extension/src/lib/turndown-rules.ts` registers
exactly two rules, `cas-images` and `demote-headings`, and nothing else:

- **Tables are destroyed.** Turndown core has no table support; a `<table>` falls through to default
  block handling and emits a run of concatenated cell text. Every archived page with a table has
  already lost it. This is a live data-loss bug, not a design preference.
- `<figure>` / `<figcaption>` flattened, caption/image association lost
- footnotes and their backlinks broken
- MathML and KaTeX output reduced to garbage text
- `<abbr>`, `<sup>`, `<sub>`, `<cite>`, `<mark>` dropped
- heading hierarchy deliberately shifted by `demote-headings`

What markdown gains is everything that makes it a vault page rather than a document: full-text
search, backlinks, block references, editability, diffability.

They are complementary, so the answer is conditional. For a text-heavy reading list markdown
suffices. For papers, documentation, and math-heavy writing it does not, and the loss is currently
silent.

### Recommended shape

1. **Fix the converter first, not the architecture.** `turndown-plugin-gfm` for tables plus rules for
   figure/caption recovers most of the loss for a fraction of the cost of a new storage tier. Note
   that GFM's strikethrough rule emits `~~`, which contradicts the vault's single-tilde convention —
   register a custom rule rather than importing the plugin wholesale.
2. **Add the reader tier only if that proves insufficient**, and when doing so mirror the feeds
   shape exactly: `ammonia::clean` server-side at ingest, stored as a CAS blob, rendered by a
   generalized `.reader-content` class that `.feed-entry-content` also adopts. No second
   sanitization strategy, no second stylesheet.
3. **Treat reader mode as a view, never a mutation.** SingleFile's editor
   (`content-ui-editor-web.js:1098-1180`) stashes `previousContent` before applying Readability and
   keeps `cancelFormatPage()` to restore it — reversibility is the design lesson worth taking, even
   though our content arrives already extracted.

### The security dividend is the real argument

If a sanitized reader tier exists, the raw snapshot never needs to be directly navigable: it becomes
a download or a sandboxed replay. G1 stops being a hole to patch and becomes a path that does not
exist. That is structurally better than a CSP header, because it removes the capability rather than
restricting it.
