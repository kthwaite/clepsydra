# Fidelity capture — manual verification (Task 9, Step 4)

**Status:** Chrome runtime matrix executed on 2026-08-13. Capture completion passed, but the exact four-stage toolbar sequence is only partially verified: `processing → uploading → done` was observed; `capturing` could not be driven through available automation. Firefox/MV2 was built and bundle-verified but not exercised in a browser.

This is the half of Task 9 that no test on the branch can replace. `capture()` runs at module scope in a content script, `getPageData` needs a real DOM, layout and network stack, and three of the branch's assumptions are only decidable against a live page.

Work through it in order — the checks are arranged so the loudest failures come first, and so that a failure early on doesn't leave you guessing about a later one.

## Setup

1. `cargo run -- serve` against a scratch vault (not your real one — check 6 deliberately fails a capture, and check 3 re-captures a URL).
2. `cd extension && bun run build`.
3. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist`.
4. Extension options → set the server URL to your scratch server.

## The checks

### 1. A capture completes at all

Any ordinary article. Watch the toolbar badge move **capturing → processing → uploading → done**.

- If it sticks on `capturing`, the content script did not run — check the page console.
- If it reaches `processing` and then reports **Archive Failed** immediately, suspect the `await send(...)` path: `capture.ts` now awaits `chrome.runtime.sendMessage` for the metadata and every chunk, and the worker returns `undefined` for both. A rejection there loses the capture *after* SingleFile has done all the work. This is residual risk #2 from the final review and is the single likeliest new failure.

### 2. Images resolve in the reading view

Open the archived page in the Folio. Images should render.

An image that renders as a broken link, or that loads from the live web rather than the vault, means the markdown join missed. **Check the markdown source for `cas:` versus an `http` URL.**

Pick a page whose images carry query parameters — a Next.js site (`/_next/image?url=…&w=…&q=…`) is ideal, because that is exactly the class the entity-decoding fix addressed. If those rewrite correctly, C1 is genuinely closed on real input.

If an image with a *simple* URL fails to rewrite, that is the URL-normalisation question: Rust's `url` crate versus the browser's `new URL()`. Both implement WHATWG URL and should agree; a disagreement would show here and nowhere else.

### 3. The snapshot is self-contained

From the frontmatter, take `archive.snapshot_hash`, then `GET /api/vault/cas/<hash>`. It will **download** rather than render — that is correct and deliberate (the G1 hardening forces `Content-Disposition: attachment` for active content types; inline rendering is the viewer spec's job).

Open the downloaded file and confirm:

- no `base64,` anywhere — every inlined resource was lifted into the CAS
- no `http://` or `https://` resource references — nothing will phone home
- `src="cas:sha256:…"` present

Also check `archive.resource_count` is greater than zero and roughly matches the page.

### 4. Iframes cost nothing and capture something

Capture a page with an embed — a YouTube video, a Disqus thread, a consent frame.

- **Time it.** Before Task 11 this cost a flat ~5s per frame while archiving nothing. It should now be materially faster.
- Check the snapshot contains the frame's content rather than an empty `<iframe>`.

### 5. SVG assets

Capture a page using SVG (most documentation sites, many logos).

`image/svg+xml` is on the active-content list, so `/api/vault/cas/{hash}` sends `Content-Disposition: attachment` for it. In `<img>` position an SVG cannot execute script, so the header protects nothing there — but browsers vary on honouring it for subresources, so the SVG may not render.

**If it breaks, the fix is to distinguish navigation from subresource loading via `Sec-Fetch-Dest` — not to drop the attachment rule.** Record the result in `docs/superpowers/specs/2026-08-12-archived-page-viewer-design.md`, under "Interaction with the CAS attachment rule".

Note separately: SingleFile inlines SVG as `data:image/svg+xml,<raw>` with no `;base64,`, so `deconstruct` leaves it inline in the snapshot. That is expected. It does mean `stored_snapshot_has_no_inlined_resources` proves less than its name suggests for SVG-bearing pages.

### 6. A capture fails cleanly

Capture something enormous, or lower `archive.max_blob_size_mb` in the scratch vault's config to force it.

You should get a **400 naming the limit**, not a bare 413. That distinction is the whole point of deriving the HTTP body limit as `max_request_size_mb * 4 / 3`; a bare 413 means the derivation regressed.

### 7. Authenticated capture

Capture a page behind a login you hold.

This exercises the page-fetch-first path in `createRelayFetch` — the reason capture happens in the browser at all rather than server-side. Resources should be present, not blank.

### 8. The long, quiet page

Find a page that is heavy locally but needs few or no cross-origin fetches — a long single-file article, or anything mostly same-origin.

The worker's idle timer is reset only incidentally by inbound relay-fetch and chunk messages during the SingleFile phase. A page needing zero relay fetches and more than ~30s of local work is the untested gap. If the capture dies mid-way with no notification, this is why.

## Not covered by any of the above

**Firefox / MV2 is entirely unexercised.** `manifest.v2.json` ships, Task 11 added new asymmetric behaviour to the MV2 injection path (frames injection resolves unconditionally and discards `lastError`; capture injection rejects on it), and no test reaches it. If Firefox is in your supported matrix, `bun run build:firefox` and repeat checks 1–4 there.

**The SingleFile-before-Readability ordering.** If those two calls in `capture.ts` were ever reversed, every capture would still succeed and every archive would quietly lose its lazy-loaded images. There is no automated guard at any layer. Check 2 on a lazy-loading page is the only thing standing behind it — so pick one that lazy-loads.

## Verification run — 2026-08-13

### Environment and setup

- macOS/Darwin 25.5.0 on Apple M4 Max.
- Google Chrome for Testing 148.0.7778.96, launched by the harness browser driver with `extension/dist` loaded unpacked. The extension service worker was `chrome-extension://cfifcfenpoaocacnppcclceocpmadfdp/background/service-worker.js`.
- Branded Google Chrome 151.0.7922.109 ignored the unpacked-extension launch flags, so it was not used for the results below. The Playwright-installed Chrome for Testing binary loaded the same production bundle successfully.
- Disposable root: `/tmp/clepsydra-task5.hjFUpX`. The vault, archive CAS and XDG config were all inside that root. The final scratch server listened on `127.0.0.1:35871` and reported `0 blobs, 0.0 MB` before capture.
- Deterministic page and cross-origin resource servers listened on `127.0.0.1:34988` and `localhost:34989`. The large bitmap was 6,297,654 bytes; CORS was deliberately absent so SingleFile's page fetch failed and the extension worker relay had to fetch it.
- Production Chromium and Firefox builds both passed bundle verification with five registered worker listeners. The first Chromium and Firefox builds exposed a missing `runtime.onConnect` verifier mock and failed; commit `5c84e15e` repaired that verifier, after which both builds passed.

### Browser matrix

| Check | Result | Observed evidence |
|---|---|---|
| 1. Ordinary capture and progress | CANNOT VERIFY full sequence; capture PASS | The framed/lazy article completed. A worker-context sampler collected 6,872 timestamped badge samples: `processing` at `17:30:02.493Z`, `uploading` at `17:30:02.545Z`, and `done` at `17:30:06.816Z`. Exact badge setter calls show the `processing` phase lasted only 22 ms (`17:30:02.491Z` to `17:30:02.513Z`). The popup capture path does not set the worker's `capturing` badge; it shows `reading the page…` inside the popup before closing. The only code path that sets the toolbar's `capturing` phase is the global shortcut. CDP key dispatch did not activate that browser-global command, and macOS rejected the attempted system keystroke with Apple Events error `-1743` (“Not authorised to send Apple events to System Events”). Therefore `capturing → processing → uploading → done` is not claimed. Raw trace: `/tmp/clepsydra-task5.hjFUpX/artifacts/phase-trace-exact.json`. Before the SingleFile runtime router was repaired, the popup closed but phase and badge stayed empty for 30–180 seconds; after the repair, the same fixture completed. |
| 2. Images in the reading view | PASS | Opened the parser-fixed archive through the actual Folio reading surface at `http://127.0.0.1:35871/workspace`, context `FILE 1B0KJPC · VIEW FOLIO` (Atrium entry `04`). In that route, Chromium's three rendered `HTMLImageElement`s had CAS `currentSrc` values and `complete = true`; `naturalWidth × naturalHeight` was 1×1 PNG, 2048×1025 BMP, and 180×80 SVG. Evidence: `/tmp/clepsydra-task5.hjFUpX/artifacts/reading-view-render.json`. The final Markdown rewrote all three URLs to `cas:`; after the unquoted-attribute join fix, `task-5-capture-matrix-article-3.md` lines 37, 39 and 41 are all CAS-backed. |
| 3. Self-contained snapshot | PASS | Snapshot `sha256:78143776115d96e96afff4bbbe6a925a98e1b22b5a4fab35d7d7f2576c2be5c3` contains no `base64,`; every active image `src` is `cas:sha256:…`. Remaining HTTP strings occur only in inert provenance (`data-sf-original-src`) and the canonical link, not resource-loading attributes. `GET /api/vault/cas/sha256:…` returned `200`, `Content-Type: text/html`, CSP sandboxing and `Content-Disposition: attachment`. Frontmatter records `resource_count = 3`. |
| 4. Iframe | PASS | The full capture completed in under 8 seconds. The stored snapshot contains the child frame's title, URL and all three frame paragraphs in `srcdoc`, not an empty iframe. Runtime traffic included frame init/ack and the 6 s idle/30 s maximum lazy-timeout routes. |
| 5. SVG | PASS | In the Folio `/workspace` reading view (`FILE 1B0KJPC · VIEW FOLIO`), the SVG `HTMLImageElement` completed with `naturalWidth = 180` and `naturalHeight = 80` despite `Content-Disposition: attachment`. Its direct CAS response was `200 image/svg+xml` with sandbox CSP, `nosniff`, and attachment disposition. |
| 6. Clean size failure | PASS | With the scratch vault's `max_blob_size_mb = 1` and the extension still capped at 100 MiB, the capture ended in the `error` phase with badge `!`. The recorded archive response was HTTP 400, not 413: `archived resource sha256:ebbf… is 6297654 bytes, over max_blob_size_mb (1 MB)`. |
| 7. Authenticated capture | PASS | `/auth/login` set an HttpOnly session cookie and redirected to the protected article. The capture completed in 3.1 seconds; the fixture log shows the capture-time `/auth/image.png?private=(yes)` request carried `task5_session=authenticated`. The stored archive contains the protected resource. |
| 8. Long, quiet page | PASS | A same-origin page with 250,029 DOM elements and no cross-origin resources captured in 50.958 seconds. Phases were `processing` at 16.088 s, `uploading` at 49.141 s and `done` at 50.958 s; the worker remained alive beyond 30 seconds. |
| >4 MiB worker relay | PASS | With CORS absent, the worker observed a `singlefile-relay` port for each cross-origin resource. The 6,297,654-byte BMP port received the URL request plus three pull messages, no abort, and the archive finished `done` in 7.9 seconds. |
| Query and balanced-parentheses join | PASS | The final Markdown rewrote `small_(balanced).png?width=800&token=a(b)c`, `large_(relay).bmp?sig=(abc)&variant=full`, and `logo_(vector).svg?theme=(navy)` to their three CAS hashes. |
| Interrupted transfer cleanup | PASS | Navigation after snapshot chunks 0 and 1 of 3 left the tab in `processing`; after the 30-second inactivity timeout it moved to `error` with badge `!` at 33.381 seconds rather than remaining stuck. A subsequent capture on the same tab completed and the success badge cleared normally, demonstrating that expired transfer state was removed. |
| Unmatched-resource accounting | PASS | With the extension's per-resource cap temporarily set to 1 MiB, the large bitmap was deliberately declined. `task-5-capture-matrix-article-4.md` keeps its HTTP URL, records `resource_count = 2`, and lists only the PNG and SVG hashes; the unmatched bitmap is not falsely claimed. |

### Stored evidence and memory

- Final joined Markdown: `/tmp/clepsydra-task5.hjFUpX/vault/archive/127.0.0.1/task-5-capture-matrix-article-3.md`.
- Deliberately unmatched Markdown: `/tmp/clepsydra-task5.hjFUpX/vault/archive/127.0.0.1/task-5-capture-matrix-article-4.md`.
- Final snapshot bytes: `/tmp/clepsydra-task5.hjFUpX/cas/78/78143776115d96e96afff4bbbe6a925a98e1b22b5a4fab35d7d7f2576c2be5c3`.
- Request evidence: `/tmp/clepsydra-task5.hjFUpX/artifacts/fixture-requests.log`; exact size-limit response: `/tmp/clepsydra-task5.hjFUpX/artifacts/limit-proxy.log`.
- Marker-bounded RSS evidence: raw 50 ms target-interval samples are in `/tmp/clepsydra-task5.hjFUpX/artifacts/server-rss-marked.tsv`; exact capture markers are in `server-rss-markers.jsonl`; calculation details are in `server-rss-marked-summary.json`. The 6,297,654-byte worker-relay capture started at `2026-08-13T17:33:03.237Z` and reached `done` at `17:33:10.691Z` (7,454 ms). The last pre-capture sample was 98,192 KiB at `17:33:03.185Z`, 52 ms before start; the preceding one-second range was 98,160–98,192 KiB. Peak RSS inside the marked capture interval was 101,200 KiB at `17:33:06.496Z`, 3,259 ms after start: an increase of 3,008 KiB from the last stable pre-capture sample. The first post-capture sample was 101,808 KiB, 8 ms after the end marker, and is intentionally excluded from the during-capture peak.
- Raw snapshot HTML remains download-only. This run does not claim inline snapshot rendering.

### Repository gates

| Command | Result |
|---|---|
| `cargo fmt --all -- --check` | FAIL: widespread pre-existing formatting drift in unrelated Rust files under rustfmt 1.9.0-stable. The changed stabilization files pass `rustfmt --edition 2024 --check src/api/archive.rs src/vault/archive_snapshot.rs`. No unrelated files were reformatted. |
| `cargo clippy --all-targets -- -D warnings` | PASS |
| `cargo test` | PASS — 1,806 tests |
| extension `bun run typecheck` | PASS |
| extension `bun run lint` | PASS — 35 files |
| extension `bun run test` | PASS — 13 files, 134 tests |
| extension `bun run build` | PASS, including Chromium bundle verification |
| extension `bun run build:firefox` | PASS, including Firefox bundle verification |
| UI `bun run typecheck` | PASS |
| UI `bun run lint` | FAIL: 20 pre-existing diagnostics in 10 unrelated files; no warnings were suppressed and no unrelated UI code was changed. |
| UI `bun run test` | PASS — 273 files, 3,492 tests; Vite emitted its existing native-config compatibility warning. |

Firefox/MV2 runtime and the browser-global `capturing` badge phase remain the two browser limitations of this run.
