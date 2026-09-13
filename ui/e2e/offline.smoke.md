# Offline PWA smoke test

Date: 2026-09-13
Branch: `feature/offline-pwa`
Build: production `ui/dist` (`bun run build`) embedded into a freshly rebuilt debug `clep` binary (`cargo build -p clep`, forced via a `touch` on `crates/clep-frontend-assets/src/lib.rs` since cargo did not otherwise detect the new `ui/dist`).
Vault: scratch vault under `/private/tmp/.../scratchpad/offline-pwa-task10/vault` with two notes (`notes/alpha.md`, `notes/beta.md`, the latter linking to the former).
Server: `CLEPSYDRA__VAULT__ROOT=<scratch> CLEPSYDRA__SERVER__HOST=127.0.0.1 CLEPSYDRA__SERVER__PORT=3999 CLEPSYDRA__SERVER__DEV_MODE=false ./target/debug/clep serve`, reached at `http://127.0.0.1:3999` (loopback is a secure context, so the service worker registers).
Driver: Playwright MCP (`browser_navigate`, `browser_evaluate`, `browser_run_code_unsafe`, `browser_snapshot`, `browser_console_messages`, `browser_network_requests`). Offline emulation via `page.context().setOffline(true/false)` inside `browser_run_code_unsafe`.

**Result: 6 of 8 Step-3 sub-steps pass. Two real bugs found (see Step 3.4 and Step 3.7) and left as-is per instructions — no application code was modified for this task.**

## Step 1: Build and serve against a scratch vault — PASS

```
cd ui && bun run build            # succeeded, PWA v1.3.0, precache 309 entries (8541.67 KiB)
cd .. && cargo build -p clep      # first run no-op (stale ui/dist embed); touch crates/clep-frontend-assets/src/lib.rs
                                   # forced the recompile ("Compiling clep-frontend-assets" -> "Compiling clep")
```

Server log confirmed: `index built pages_indexed=2 pages_skipped=0 pages_removed=0 warnings=0`, then `listening (HTTP) addr=127.0.0.1:3999`. A benign warning appeared (`CAS ... is empty but a legacy store exists ...; archived pages will 404`) — expected for a scratch vault, irrelevant to this smoke test (no archived attachments are exercised).

**Note for future runs:** `cargo build -p clep` did not pick up the new `ui/dist` on its own (binary timestamp predated the dist rebuild). Touching `crates/clep-frontend-assets/src/lib.rs` (or any file in that crate) forces the `rust-embed` re-embed. Worth a follow-up ticket if this is a recurring rebuild footgun.

## Step 2: Header checks — PASS

```
$ curl -sI http://127.0.0.1:3999/sw.js | grep -iE 'cache-control|content-type'
content-type: text/javascript
cache-control: no-cache

$ curl -sI http://127.0.0.1:3999/manifest.webmanifest | grep -iE 'cache-control|content-type'
content-type: application/manifest+json
cache-control: no-cache

$ curl -sI "http://127.0.0.1:3999/assets/_-DxUZlokq.js" | grep -i cache-control
cache-control: public, max-age=31536000, immutable

$ curl -sI http://127.0.0.1:3999/ | grep -i content-security-policy
content-security-policy: default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; manifest-src 'self'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'
```

All four checks match expectations exactly: `sw.js` is `no-cache` + `text/javascript`; the manifest is `no-cache` + `application/manifest+json`; the hashed asset is `immutable`; the CSP contains both `worker-src 'self'` and `manifest-src 'self'`.

## Step 3: Browser run

### 3.1 SW controller after 5s — PASS

Navigated to `http://127.0.0.1:3999/`, waited 5s, evaluated `navigator.serviceWorker.controller !== null` → `true`.

Observed console noise on this and later loads, all pre-existing and unrelated to the offline feature: font-src CSP violations for base64 `data:` woff2 fonts (icon font embedded as a data URI collides with `font-src 'self'`), and 404s for `/api/vault/bases/reading/views/Continues`, `/api/vault/journal/today`, `/api/vault/ai-journal/today` (the scratch vault has no bases/journal pages). Not investigated further — out of scope for this task and not offline-specific.

### 3.2 Cache population — PASS

`caches.keys()` → `["workbox-precache-v2-http://127.0.0.1:3999/", "clep-api-v1"]`. `clep-api-v1` entry count = **18** (≥ 6 required).

### 3.3 Set context offline — PASS

`page.context().setOffline(true)` via `browser_run_code_unsafe`.

### 3.4 Navigate to an unopened page while offline — PASS (assertions), but exposed a serious separate crash bug

Navigated to `/pages/notes/beta.md` (never opened this session). Immediate snapshot showed all three required elements:
- Body renders "Beta links to" (with the wikilink to Alpha rendered inline).
- Banner present: *"Offline — read only. Edits resume when the connection returns."*
- Footer status: *"Offline — vault as of 15:53"*.

**However**, while investigating Step 3.5 immediately afterward, the app went completely blank (`document.body.innerHTML` collapsed from ~21,000 chars to `"\n    <div id=\"root\"></div>\n  \n\n"`, i.e. 31 chars) roughly **4–7 seconds after page load**, on every route tried (`/`, `/pages/notes/beta.md`), reproduced 4 times. `document.title` resets to the static `<title>Clepsydra</title>` fallback at the same instant, and `page.on('pageerror')` fires with an uncaught exception (message serialized as `"Object"` by Chromium/CDP, i.e. a non-`Error` rejection value) — evidence of a genuine full-document reload followed by an uncaught render-time exception, not a client-side state change.

**Root cause (read-only investigation, no code changed):** `ui/dist/assets/lazyRouteComponent-BMUAbcj5.js` bundles TanStack Router's `lazyRouteComponent` helper. On a failed dynamic `import()` (detected via a "Failed to fetch dynamically imported module" / "error loading dynamically imported module" message match), it does, once per unique error message (guarded by `sessionStorage`):
```js
sessionStorage.setItem(key, '1');
window.location.reload();
throw new Promise(() => {}); // suspends forever, letting the reload complete
```
On a **second** failure of the *same* import (session flag already set — which is guaranteed here because the browser is still offline after the reload, so the same chunk fetch fails again), the code instead does `throw a` — the raw caught rejection — synchronously during render. This is not a Promise, so React Suspense does not catch it; nothing in the tree stops it, and the whole React root unmounts, leaving the page permanently blank until the tab is reloaded while back online.

This reproduces on **every route**, not just `notes/beta.md`, and independent of which specific route chunk triggers it; the ~4s timing lines up with the vault walker's documented "fetch the whole vault 3s after launch" behavior (some code path invoked from that walker performs a dynamic import that isn't available offline). Exact chunk/module was not pinned down further (out of scope — read-only smoke test, no code changes made) but the mechanism and timing are fully reproducible.

Evidence saved:
- Screenshot of the blank crash: `/private/tmp/claude-501/-Users-kit-Source--p-pkm-clepsydra/b03917ec-b646-42cb-b47b-9eadca1fc490/scratchpad/offline-pwa-task10/evidence/step3.4-blank-crash-screenshot.png`
- Console log around the crash: `/private/tmp/claude-501/-Users-kit-Source--p-pkm-clepsydra/b03917ec-b646-42cb-b47b-9eadca1fc490/scratchpad/offline-pwa-task10/evidence/blank-crash-console.log`
- Timeline data (`t` = ms since load, `len` = `document.body.innerHTML.length`), captured twice independently:
  ```
  t=4017 len=21003   t=4520 len=31   (title flips lowercase "clepsydra" -> "Clepsydra" at the same instant)
  t=4013 len=75752   t=4515 len=31   (same phenomenon on the "/" route)
  ```

**This is a real, reproducible offline-mode regression and should be filed as a follow-up bug**: the offline PWA becomes fully unusable (blank screen, no error UI) a few seconds after going offline on any route, not just the specific route that first triggers the failed chunk load.

To keep testing the remaining Step 3 sub-steps despite this, each subsequent sub-step below was run in a **fresh Playwright page within the same (offline) browser context** so it gets a clean few-second window before the same crash recurs — the underlying vault/cache/SW state is shared across pages in the same context, so this does not weaken the sub-step's assertion.

### 3.5 Search "water" while offline — PASS

Opened a fresh page, navigated to `/`, pressed `⌘K`, typed into the located `<input placeholder="Search pages · kind:recipe (tag:beer | tag:wine)">`, typed `water`. Result: `FILE 06twy1o ALPHA — "Alpha talks about water clocks." — 1 HITS`. Confirms the offline MiniSearch fallback index is populated and returns a correct match for content that was never directly visited this session.

(First attempt used a raw `keyboard.type` without confirming focus landed in the search input and produced 0 hits against the static command list — a test-script mistake, not a product bug; corrected by locating `document.activeElement` before typing.)

### 3.6 `/tasking` and `/agenda` render from cache — PASS

Both routes rendered their full shell (Task Board columns: Inbox/Ready/In Progress/Review/Done all present with "NO TASKS"; Agenda's Overdue/Due Today sections both present) with no route-error text ("Something went wrong" / "Route Error" / "unexpected error" all absent) in either page's body text.

### 3.7 Navigate to a page that was never in the vault — **FAIL**

Navigated to `/pages/notes/missing.md`. Network requests confirmed the service worker correctly returns `503 (Offline)` for the uncached page and its side-fetches (`/api/vault/pages/notes%2Fmissing.md`, `.../index/backlinks/...`, `.../index/outlinks/...`, `.../index/similar/...`), each retried three times over ~8s. But the UI **never** shows "Not available offline": it is still displaying the loading state `"… fetching folio notes/missing.md …"` (with a stalled `0%` progress indicator) at 6 full seconds, with no further progress. It does not appear to be racing the Step-3.4 crash bug either — the page stayed at a stable ~9.5 KB `innerHTML` (a real, non-blank, "stuck-loading" state), it simply never transitions to an error/empty state.

Screenshot: `/private/tmp/claude-501/-Users-kit-Source--p-pkm-clepsydra/b03917ec-b646-42cb-b47b-9eadca1fc490/scratchpad/offline-pwa-task10/step3-7-missing-page.png`

Timeline (500ms steps, `hasNotAvail` = body text contains "Not available offline"):
```
t=500..5000ms: len stays ~303-9490 chars, hasNotAvail=false throughout; body text still reads
"… fetching folio notes/missing.md …" at every sample point.
```

**This is a second real bug**: a genuinely-missing page's offline empty-state message never appears; the UI is stuck in an indefinite loading spinner instead. Filed as-is, no code changed.

### 3.8 Go online, edit on disk, confirm SSE-triggered re-cache — PASS

Restored `page.context().setOffline(false)`. Opened a fresh page, navigated to `/` and let it settle for 3s (SSE connects, initial walker pass completes). Appended a line to `$SCRATCH/notes/alpha.md` on disk twice (once against the just-crashed original tab's tracking, then again against the confirmed-live tab, to guarantee a delta was observed by a connected client — see note below). Waited 7s (watcher debounce + 2s coalesce + fetch per the brief).

Read back via the live tab:
```js
(await (await caches.open("clep-api-v1")).match("/api/vault/pages/notes%2Falpha.md")).text()
```
Body (truncated to the relevant field):
```json
"body":"\nAlpha talks about water clocks.\nAlpha also mentions Ctesibius.\nAlpha also mentions Ctesibius and the clepsydra water clock.\n"
```
Both appended lines are present in the cached entry, confirming the SSE-driven walker refetched and re-cached the page **without the page itself being visited/re-navigated** in that tab.

Note: the first on-disk append happened while the only open tab was the one already blanked by the Step 3.4 crash, so its (dead) SSE connection could not have driven a re-fetch for that edit. A second append was made after opening a fresh, confirmed-live tab, and the final cache check reflects both lines — so the passing result specifically demonstrates the live tab's SSE-triggered re-cache, not a stale artifact from a manual page visit (alpha.md was not navigated to directly in this sequence).

## Step 4: iOS device check (user-run) — PENDING USER VERIFICATION

Not run in this smoke test (requires a physical iOS device on the same network/tailnet). Steps for the user:

1. On the iOS device, open Safari and navigate to the tailnet URL for this vault's server (e.g. `https://<host>.tailnet-name.ts.net`).
2. Tap the Share icon → "Add to Home Screen" → confirm.
3. Launch the app from the Home Screen icon (opens standalone, no Safari chrome).
4. Go to Settings → Advanced → "Offline copy" card and wait for it to show the page count (confirms the initial vault walk completed).
5. Enable Airplane Mode.
6. Open a page you have not visited this session — confirm it renders with the "Offline — read only" banner.
7. Use search (magnifying glass / search route) for a term you know is in the vault — confirm a result appears.
8. Open the Task Board — confirm it renders from cache.
9. Disable Airplane Mode and confirm the app returns to normal (online) behavior.

Given the two bugs found in Step 3 (the blank-crash a few seconds after going offline, and the stuck-loading state for missing pages), the user should specifically watch for the app going blank a few seconds after enabling Airplane Mode when doing step 6 — if step-3.4's bug reproduces on iOS Safari, the whole offline PWA is effectively unusable there until this is fixed.

**Status: pending — user has not yet run this.**

## Summary

| Step | Outcome |
|---|---|
| 1. Build and serve | PASS |
| 2. Header checks | PASS |
| 3.1 SW controller | PASS |
| 3.2 Cache population (18 ≥ 6) | PASS |
| 3.3 Set offline | PASS |
| 3.4 Unopened page offline | PASS (assertions met), but surfaced the blank-crash bug described above |
| 3.5 Search offline | PASS |
| 3.6 `/tasking`, `/agenda` offline | PASS |
| 3.7 Missing page offline | **FAIL** — never reaches "Not available offline"; stuck loading indefinitely |
| 3.8 SSE delta re-cache | PASS |
| 4. iOS device check | PENDING (user-run) |

**Two application bugs found, not fixed (out of scope for this task):**
1. A few seconds after going offline, on any route, the app throws an uncaught exception (via TanStack Router's `lazyRouteComponent` reload-once-then-throw recovery path colliding with being offline) and unmounts to a permanently blank screen.
2. Navigating to a page that doesn't exist while offline never surfaces the "Not available offline" message — the UI is stuck on an indefinite loading spinner instead.
