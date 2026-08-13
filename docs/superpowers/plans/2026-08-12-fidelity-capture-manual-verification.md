# Fidelity capture — manual verification (Task 9, Step 4)

**Status:** outstanding. Everything else on `feature/fidelity-capture` is implemented, reviewed and gated.

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
