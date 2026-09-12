# Offline PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Clepsydra UI an installable, read-only-offline Progressive Web App on iOS that keeps the whole vault (pages, links, navigation views, search) readable without a connection.

**Architecture:** A Workbox service worker (`ui/src/sw.ts`) precaches the app shell and runtime-caches every `/api/vault/*` GET NetworkFirst into one Cache API bucket. A page-side walker (`ui/src/offline/sync.ts`) fetches the whole vault through that worker so the bucket is complete, re-fetching deltas on SSE `index_changed`. An openapi-fetch middleware answers `/api/vault/index/search` from cached page bodies with MiniSearch when the server is unreachable. The editor goes read-only and the sync indicator shows "Offline" when `navigator.onLine` is false or the SSE stream has been down for 10 s.

**Tech Stack:** Rust/Axum (`crates/clep-frontend-assets`), Vite 8 + `vite-plugin-pwa` 1.3 (injectManifest) + `workbox-*` 7.4, React 19, TanStack Query 5, `openapi-fetch` 0.15 middleware, `minisearch` 7.2, zustand 5 (`persist`), vitest 4 + jsdom, `rsvg-convert` for icons.

**Spec:** `docs/superpowers/specs/2026-09-12-offline-pwa-design.md`

## Global Constraints

- Read-only offline. No write queue, no draft persistence, no offline mutations.
- Never cache: non-GET requests, `GET /api/vault/events`, `/api/vault/cas/*`, `/api/vault/attachments/*`, `/api/docs*`, `/api/openapi.json`.
- API cache name is exactly `clep-api-v1`. NetworkFirst timeout is exactly 4 seconds. Only status 200 responses are cached.
- Offline miss response: status `503`, JSON body `{ "code": "offline_uncached", "url": "<request url>" }`, `Content-Type: application/json`.
- Walker concurrency ceiling 6; per-request timeout 15 s; delta coalescing 2 s; launch delay 3 s; full pass forced when `lastFullSync` older than 24 h.
- Online status = `navigator.onLine && sseConnected`; SSE "disconnected" counts as offline only after 10 s continuous disconnect.
- SSE reconnect backoff: 3 s doubling to a 60 s cap, ±20 % jitter, reset on open, paused while `navigator.onLine` is false.
- Service worker disabled in Vite dev (`devOptions.enabled: false`). Verified only against `bun run build` + `clep serve`.
- No API route, DTO, or `schema.d.ts` changes.
- Path params are built by `fetchClient` (openapi-fetch encodes them with `encodeURIComponent`, so `notes/a.md` becomes `notes%2Fa.md`). The walker MUST issue requests through `fetchClient` so its URLs match the hooks' URLs byte for byte.
- Copy: banner "Offline — read only"; indicator "Offline — vault as of HH:MM" / "Offline — no offline copy"; route error title "Not available offline", body "This page hasn't been synced to this device yet."
- `ui/` commands run as `cd ui && bun run <script>` (never `bun --cwd`). Rust commands run from the repo root.
- Any `clep` run for smoke testing MUST set `CLEPSYDRA__VAULT__ROOT` to a scratch vault (the ambient `~/.config/clepsydra/config.toml` points at the live vault).
- Stage explicit paths with `git add <paths>`; never `git add .`.
- Work on a feature branch off `develop`: `git checkout -b feature/offline-pwa develop`.

---

## File map

| File | Responsibility |
|---|---|
| `crates/clep-frontend-assets/src/lib.rs` | `cache_control_for(path)` + `content_type_for(path)` pure helpers; headers applied in `static_handler`; CSP gains `worker-src`/`manifest-src` |
| `ui/src/offline/swPolicy.ts` | Pure request classification + `offlineUncachedResponse` + `isOfflineUncached`; imported by the SW and the UI |
| `ui/src/sw.ts` | The service worker: precache, navigation route, NetworkFirst API route, network-only route |
| `ui/vite.config.ts`, `ui/tsconfig.sw.json`, `ui/tsconfig.json`, `ui/tsconfig.app.json`, `ui/package.json` | Plugin config, SW typecheck project, `virtual:pwa-register` types |
| `ui/public/pwa-192.png`, `ui/public/pwa-512.png`, `ui/public/pwa-maskable-512.png`, `ui/public/apple-touch-icon.png` | Rasterised icons |
| `ui/index.html` | iOS meta tags, apple-touch-icon, `viewport-fit=cover` |
| `ui/src/main.tsx` | `registerSW` call (production only) |
| `ui/src/offline/connectionStore.ts` | zustand store: SSE `status` + `disconnectedSince`; written by `useVaultEvents` |
| `ui/src/hooks/useVaultEvents.ts` | Backoff reconnect, online/offline pause, writes `connectionStore` |
| `ui/src/hooks/useOnlineStatus.ts` | `navigator.onLine && sse` with 10 s grace |
| `ui/src/offline/offlineStore.ts` | zustand + `persist`: walker phase/progress/lastFullSync/pageCount/lastError |
| `ui/src/offline/walkSet.ts` | The pinned derived-view request table (`WALK_SET`) and the per-page triple |
| `ui/src/offline/sync.ts` | `runFullSync`, `runDeltaSync`, `OfflineSyncController` (coalescing, rerun, guards, prune) |
| `ui/src/offline/useOfflineSync.ts` | Mounts the controller: launch trigger, SSE deltas, exposes `syncNow` |
| `ui/src/offline/search.ts` | MiniSearch index over cached page bodies + openapi-fetch middleware |
| `ui/src/offline/testing/fakeCaches.ts` | In-memory `CacheStorage` for vitest |
| `ui/src/api/client.ts` | Registers the search middleware |
| `ui/src/components/SyncIndicator.tsx`, `ui/src/components/codex/DesktopCodexFrame.tsx` | "Offline" status |
| `ui/src/components/settings/OfflinePanel.tsx`, `ui/src/components/SettingsModal.tsx` | Offline copy status + "Sync now" |
| `ui/src/editor/usePageEditor.ts`, `ui/src/components/codex/Folio.tsx` | Read-only while offline + banner |
| `ui/src/components/RouteError.tsx` | "Not available offline" branch |
| `ui/src/docs/content/getting-started.mdx` | "Install on iPhone and offline reading" section |

---

### Task 1: Static asset cache headers and CSP

**Files:**
- Modify: `crates/clep-frontend-assets/src/lib.rs`

**Interfaces:**
- Produces: `fn cache_control_for(path: &str) -> &'static str`, `fn content_type_for(path: &str) -> String` (private; used by `static_handler` and tests).

- [ ] **Step 1: Write the failing tests**

Append inside the existing `mod tests` in `crates/clep-frontend-assets/src/lib.rs`:

```rust
    #[test]
    fn hashed_assets_are_immutable_and_shell_files_are_revalidated() {
        assert_eq!(
            cache_control_for("assets/index-m5_YmWWd.js"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(cache_control_for("assets/react-CwJFpaho.js"), "public, max-age=31536000, immutable");
        for shell in ["index.html", "sw.js", "manifest.webmanifest", "registerSW.js", ""] {
            assert_eq!(cache_control_for(shell), "no-cache", "path {shell:?}");
        }
        assert_eq!(cache_control_for("favicon.svg"), "no-cache");
    }

    #[test]
    fn manifest_and_common_assets_get_the_right_content_type() {
        assert_eq!(content_type_for("manifest.webmanifest"), "application/manifest+json");
        assert_eq!(content_type_for("sw.js"), "text/javascript");
        assert_eq!(content_type_for("assets/a.css"), "text/css");
        assert_eq!(content_type_for("pwa-512.png"), "image/png");
    }

    #[tokio::test]
    async fn responses_carry_cache_control() {
        let index = static_handler(Uri::from_static("/index.html")).await.into_response();
        assert_eq!(
            index.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()),
            Some("no-cache")
        );

        let fallback = static_handler(Uri::from_static("/docs/anything")).await.into_response();
        assert_eq!(
            fallback.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()),
            Some("no-cache")
        );

        let asset = Assets::iter()
            .find(|path| path.starts_with("assets/"))
            .expect("at least one hashed asset");
        let uri = Uri::try_from(format!("/{asset}")).expect("asset URI");
        let asset = static_handler(uri).await.into_response();
        assert_eq!(
            asset.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()),
            Some("public, max-age=31536000, immutable")
        );
    }

    #[test]
    fn csp_allows_same_origin_workers_and_manifest() {
        assert!(CONTENT_SECURITY_POLICY.contains("worker-src 'self'"));
        assert!(CONTENT_SECURITY_POLICY.contains("manifest-src 'self'"));
    }
```

Also update `EXPECTED_CSP` in the tests module to the new string (see Step 3).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p clep-frontend-assets`
Expected: compile error, `cache_control_for` and `content_type_for` not found.

- [ ] **Step 3: Implement**

Replace the CSP constant and `static_handler` in `crates/clep-frontend-assets/src/lib.rs`:

```rust
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; base-uri 'self'; connect-src 'self'; \
    font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; \
    manifest-src 'self'; object-src 'none'; script-src 'self'; \
    style-src 'self' 'unsafe-inline'; worker-src 'self'";

/// Hashed build output under `assets/` never changes at a given URL, so it may
/// be cached for a year. Everything else (the HTML shell, the service worker,
/// the manifest, unhashed public files) must be revalidated on every load so a
/// deploy is picked up and the service worker update check sees new bytes.
fn cache_control_for(path: &str) -> &'static str {
    if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

fn content_type_for(path: &str) -> String {
    if path.ends_with(".webmanifest") {
        return "application/manifest+json".to_string();
    }
    mime_guess::from_path(path)
        .first_or_octet_stream()
        .essence_str()
        .to_string()
}

async fn static_handler(uri: Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');

    let (mut response, cache_control) = if path.is_empty() || path == "index.html" {
        (index_html().await, cache_control_for("index.html"))
    } else if let Some(content) = Assets::get(path) {
        let response = Response::builder()
            .header(header::CONTENT_TYPE, content_type_for(path))
            .body(Body::from(content.data))
            .unwrap();
        (response, cache_control_for(path))
    } else {
        // SPA fallback: serve index.html for unknown paths
        (index_html().await, cache_control_for("index.html"))
    };

    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    with_security_headers(response)
}
```

Update the tests' `EXPECTED_CSP` to the same string as `CONTENT_SECURITY_POLICY`. (`essence_str()` drops `; charset=utf-8` from `text/javascript`; that keeps the test exact. If `mime_guess` maps `.js` to `application/javascript` in the pinned version, change the test expectation to whatever `cargo test` prints, not the code.)

- [ ] **Step 4: Run tests**

Run: `cargo test -p clep-frontend-assets`
Expected: all pass (existing tests still green with the new CSP).

- [ ] **Step 5: Lint and commit**

Run: `cargo clippy -p clep-frontend-assets --all-targets -- -D warnings && cargo fmt --check`
```bash
git add crates/clep-frontend-assets/src/lib.rs
git commit -m "feat(frontend-assets): cache-control for hashed assets, no-cache shell, worker/manifest CSP"
```

---

### Task 2: Service-worker policy module

**Files:**
- Create: `ui/src/offline/swPolicy.ts`
- Test: `ui/src/offline/swPolicy.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const API_CACHE_NAME = "clep-api-v1";
  export const OFFLINE_UNCACHED_CODE = "offline_uncached";
  export type RequestClass = "network-only" | "api" | "navigation" | "asset";
  export function classifyRequest(input: { url: URL; method: string; mode: RequestMode; origin: string }): RequestClass;
  export function offlineUncachedResponse(url: string): Response;
  export function isOfflineUncached(body: unknown): body is { code: "offline_uncached"; url: string };
  ```

- [ ] **Step 1: Write the failing tests**

`ui/src/offline/swPolicy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  API_CACHE_NAME,
  classifyRequest,
  isOfflineUncached,
  offlineUncachedResponse,
} from "#/offline/swPolicy";

const ORIGIN = "https://gathering.example.ts.net";

function classify(path: string, method = "GET", mode: RequestMode = "cors") {
  return classifyRequest({
    url: new URL(path, ORIGIN),
    method,
    mode,
    origin: ORIGIN,
  });
}

describe("classifyRequest", () => {
  it("never caches non-GET requests", () => {
    expect(classify("/api/vault/pages/x.md", "PUT")).toBe("network-only");
    expect(classify("/api/vault/tasks", "POST")).toBe("network-only");
    expect(classify("/api/vault/pages/x.md", "DELETE")).toBe("network-only");
  });

  it("never caches the SSE stream, blobs, or api docs", () => {
    expect(classify("/api/vault/events")).toBe("network-only");
    expect(classify("/api/vault/cas/abc123")).toBe("network-only");
    expect(classify("/api/vault/attachments/img%2Fa.png")).toBe("network-only");
    expect(classify("/api/vault/attachments")).toBe("network-only");
    expect(classify("/api/docs")).toBe("network-only");
    expect(classify("/api/docs/")).toBe("network-only");
    expect(classify("/api/openapi.json")).toBe("network-only");
  });

  it("routes vault GETs and the feature flags through the api cache", () => {
    expect(classify("/api/vault/pages/notes%2Fa.md")).toBe("api");
    expect(classify("/api/vault/index/search?q=x&limit=20")).toBe("api");
    expect(classify("/api/features")).toBe("api");
  });

  it("treats navigations as the app shell", () => {
    expect(classify("/pages/notes/a.md", "GET", "navigate")).toBe("navigation");
    expect(classify("/", "GET", "navigate")).toBe("navigation");
  });

  it("treats other same-origin GETs as assets", () => {
    expect(classify("/assets/index-abc.js")).toBe("asset");
    expect(classify("/favicon.svg")).toBe("asset");
  });

  it("sends cross-origin requests to the network", () => {
    expect(
      classifyRequest({
        url: new URL("https://fonts.example/x.woff2"),
        method: "GET",
        mode: "cors",
        origin: ORIGIN,
      }),
    ).toBe("network-only");
  });

  it("names the api cache", () => {
    expect(API_CACHE_NAME).toBe("clep-api-v1");
  });
});

describe("offlineUncachedResponse", () => {
  it("is a 503 json response carrying the code and url", async () => {
    const response = offlineUncachedResponse(`${ORIGIN}/api/vault/pages/a.md`);
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = await response.json();
    expect(body).toEqual({
      code: "offline_uncached",
      url: `${ORIGIN}/api/vault/pages/a.md`,
    });
    expect(isOfflineUncached(body)).toBe(true);
  });

  it("rejects other shapes", () => {
    expect(isOfflineUncached(null)).toBe(false);
    expect(isOfflineUncached({ code: "revision_conflict" })).toBe(false);
    expect(isOfflineUncached("offline_uncached")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && bun run test src/offline/swPolicy.test.ts`
Expected: FAIL, cannot resolve `#/offline/swPolicy`.

- [ ] **Step 3: Implement**

`ui/src/offline/swPolicy.ts`:

```ts
/**
 * Request classification shared by the service worker (`src/sw.ts`) and the
 * page. Kept free of worker globals so vitest covers it in jsdom.
 */

export const API_CACHE_NAME = "clep-api-v1";
export const OFFLINE_UNCACHED_CODE = "offline_uncached";

export type RequestClass = "network-only" | "api" | "navigation" | "asset";

const NETWORK_ONLY_PREFIXES = [
  "/api/vault/events",
  "/api/vault/cas/",
  "/api/vault/attachments",
  "/api/docs",
  "/api/openapi.json",
];

export function classifyRequest(input: {
  url: URL;
  method: string;
  mode: RequestMode;
  origin: string;
}): RequestClass {
  const { url, method, mode, origin } = input;
  if (url.origin !== origin) return "network-only";
  if (method.toUpperCase() !== "GET") return "network-only";
  if (mode === "navigate") return "navigation";

  const path = url.pathname;
  if (NETWORK_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return "network-only";
  }
  if (path.startsWith("/api/vault/") || path === "/api/features") {
    return "api";
  }
  if (path.startsWith("/api/")) return "network-only";
  return "asset";
}

export function offlineUncachedResponse(url: string): Response {
  return new Response(JSON.stringify({ code: OFFLINE_UNCACHED_CODE, url }), {
    status: 503,
    statusText: "Offline",
    headers: { "content-type": "application/json" },
  });
}

export function isOfflineUncached(
  body: unknown,
): body is { code: "offline_uncached"; url: string } {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { code?: unknown }).code === OFFLINE_UNCACHED_CODE
  );
}
```

- [ ] **Step 4: Run tests**

Run: `cd ui && bun run test src/offline/swPolicy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/offline/swPolicy.ts ui/src/offline/swPolicy.test.ts
git commit -m "feat(ui): service worker request policy module"
```

---

### Task 3: PWA plugin, service worker, manifest, icons, registration

**Files:**
- Modify: `ui/package.json`, `ui/vite.config.ts`, `ui/tsconfig.json`, `ui/tsconfig.app.json`, `ui/index.html`, `ui/src/main.tsx`
- Create: `ui/tsconfig.sw.json`, `ui/src/sw.ts`, `ui/public/pwa-192.png`, `ui/public/pwa-512.png`, `ui/public/pwa-maskable-512.png`, `ui/public/apple-touch-icon.png`
- Test: build output inspection (this task is verified by `bun run build` + file assertions; the SW body is exercised by Task 10's smoke run)

**Interfaces:**
- Consumes: `classifyRequest`, `offlineUncachedResponse`, `API_CACHE_NAME` from Task 2.
- Produces: `ui/dist/sw.js`, `ui/dist/manifest.webmanifest`, registration on production load.

- [ ] **Step 1: Install dependencies**

```bash
cd ui && bun add vite-plugin-pwa@^1.3.0 workbox-precaching@^7.4.0 workbox-routing@^7.4.0 workbox-strategies@^7.4.0 workbox-cacheable-response@^7.4.0
```
Expected: `package.json` gains the five deps; `bun.lock` updated. (`vite-plugin-pwa` in `dependencies` is fine; the project already keeps Vite plugins there.)

- [ ] **Step 2: Rasterise icons**

```bash
cd ui/public
rsvg-convert -w 192 -h 192 favicon.svg -o pwa-192.png
rsvg-convert -w 512 -h 512 favicon.svg -o pwa-512.png
rsvg-convert -w 180 -h 180 -b '#efece2' favicon.svg -o apple-touch-icon.png
rsvg-convert -w 410 -h 410 --page-width 512 --page-height 512 --left 51 --top 51 -b '#efece2' favicon.svg -o pwa-maskable-512.png
file pwa-192.png pwa-512.png apple-touch-icon.png pwa-maskable-512.png
```
Expected: four PNGs with the stated dimensions. `#efece2` is the Vessel light `--paper` token (`ui/src/main.css` line ~148); the mark itself renders in light-mode ink `#15140f` because `rsvg-convert` does not apply the `prefers-color-scheme: dark` rule.

- [ ] **Step 3: Vite config**

Edit `ui/vite.config.ts`: add the import and plugin entry.

```ts
import { VitePWA } from "vite-plugin-pwa";
```

Append to `plugins` after `react(...)`:

```ts
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Clepsydra",
        short_name: "Clepsydra",
        description: "Personal knowledge vault",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#efece2",
        theme_color: "#efece2",
        icons: [
          { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/pwa-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,woff2,png}"],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
```

- [ ] **Step 4: Service worker**

`ui/src/sw.ts`:

```ts
/// <reference lib="webworker" />
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkFirst, NetworkOnly } from "workbox-strategies";
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import {
  API_CACHE_NAME,
  classifyRequest,
  offlineUncachedResponse,
} from "./offline/swPolicy";

declare const self: ServiceWorkerGlobalScope;

// New deploys take over immediately; the page reloads on its own next launch.
self.skipWaiting();
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// App shell: every hashed chunk plus index.html, injected at build time.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA navigations always get the precached shell so deep links work offline.
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html")));

const apiStrategy = new NetworkFirst({
  cacheName: API_CACHE_NAME,
  networkTimeoutSeconds: 4,
  plugins: [new CacheableResponsePlugin({ statuses: [200] })],
});

function classOf(url: URL, request: Request) {
  return classifyRequest({
    url,
    method: request.method,
    mode: request.mode,
    origin: self.location.origin,
  });
}

registerRoute(
  ({ url, request }) => classOf(url, request) === "network-only",
  new NetworkOnly(),
);

registerRoute(
  ({ url, request }) => classOf(url, request) === "api",
  async (options) => {
    try {
      return await apiStrategy.handle(options);
    } catch {
      // NetworkFirst throws when neither the network nor the cache answered.
      return offlineUncachedResponse(options.request.url);
    }
  },
);
```

`self.__WB_MANIFEST` is typed by `workbox-precaching`'s ambient `ServiceWorkerGlobalScope` augmentation; if `tsc` complains, add `declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<import("workbox-precaching").PrecacheEntry | string> };` in place of the plain declaration.

- [ ] **Step 5: Typecheck project for the worker**

Create `ui/tsconfig.sw.json`:

```json
{
  "extends": "./tsconfig.app.json",
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.sw.tsbuildinfo",
    "lib": ["ES2022", "WebWorker"],
    "types": ["vite/client"]
  },
  "include": ["src/sw.ts", "src/offline/swPolicy.ts"]
}
```

Edit `ui/tsconfig.app.json`: add `"exclude": ["src/sw.ts"]` at top level (keep `"include": ["src"]`), and change `"types": ["vite/client"]` to `"types": ["vite/client", "vite-plugin-pwa/client"]`.

Edit `ui/tsconfig.json` references to add `{ "path": "./tsconfig.sw.json" }`.

Edit `ui/package.json` scripts: `"typecheck": "tsc --noEmit --project tsconfig.app.json && tsc --noEmit --project tsconfig.sw.json"`.

- [ ] **Step 6: index.html and registration**

`ui/index.html` head becomes:

```html
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1.0, viewport-fit=cover"
    />
    <meta name="theme-color" content="#efece2" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="Clepsydra" />
    <title>Clepsydra</title>
    <script src="/theme-bootstrap.js"></script>
```

The plugin injects `<link rel="manifest">` at build time.

`ui/src/main.tsx`: add after the css imports:

```ts
import { registerSW } from "virtual:pwa-register";

if (import.meta.env.PROD) {
  registerSW({ immediate: true });
}
```

- [ ] **Step 7: Build and verify output**

```bash
cd ui && bun run typecheck && bun run build
ls dist/sw.js dist/manifest.webmanifest dist/pwa-512.png dist/apple-touch-icon.png
grep -c 'clep-api-v1' dist/sw.js
grep -o '<link rel="manifest"[^>]*>' dist/index.html
grep -o 'apple-mobile-web-app-capable' dist/index.html
node -e 'const m=require("./dist/manifest.webmanifest");console.log(m.display,m.icons.length)'
```
Expected: all four files exist; `1` (or more) for the cache name; a manifest link; the meta tag; `standalone 3`.

- [ ] **Step 8: Rust side sees the new files**

Run: `cargo test -p clep-frontend-assets`
Expected: PASS (the embedded `dist` now contains `sw.js`; `content_type_for("sw.js")` test unchanged).

- [ ] **Step 9: Lint, knip, commit**

```bash
cd ui && bun run lint && bun run knip
```
If knip reports `src/sw.ts` as an unused file, add to `ui/package.json` a `"knip": { "entry": ["src/main.tsx", "src/sw.ts"] }` block mirroring any existing knip config (check `bunx knip --show-config` first) and re-run.

```bash
git add ui/package.json ui/bun.lock ui/vite.config.ts ui/tsconfig.json ui/tsconfig.app.json ui/tsconfig.sw.json ui/index.html ui/src/main.tsx ui/src/sw.ts ui/public/pwa-192.png ui/public/pwa-512.png ui/public/pwa-maskable-512.png ui/public/apple-touch-icon.png
git commit -m "feat(ui): installable PWA shell with workbox service worker"
```

---

### Task 4: Connection store, SSE backoff, online status

**Files:**
- Create: `ui/src/offline/connectionStore.ts`, `ui/src/hooks/useOnlineStatus.ts`
- Modify: `ui/src/hooks/useVaultEvents.ts`
- Test: `ui/src/hooks/useVaultEvents.backoff.test.tsx`, `ui/src/hooks/useOnlineStatus.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  // connectionStore.ts
  export type ConnectionStatus = "connecting" | "connected" | "disconnected";
  export interface ConnectionState { status: ConnectionStatus; disconnectedSince: number | null; setStatus: (s: ConnectionStatus, now?: number) => void; }
  export const useConnectionStore: UseBoundStore<StoreApi<ConnectionState>>;
  // useVaultEvents.ts
  export function useVaultEvents(): ConnectionStatus;   // unchanged signature; now also writes the store
  export const SSE_BACKOFF = { initialMs: 3000, maxMs: 60000, jitter: 0.2 };
  export function nextBackoffMs(attempt: number, random?: () => number): number;
  // useOnlineStatus.ts
  export const SSE_DISCONNECT_GRACE_MS = 10_000;
  export function useOnlineStatus(): boolean;
  export function computeOnline(input: { navigatorOnline: boolean; status: ConnectionStatus; disconnectedSince: number | null; now: number }): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

`ui/src/hooks/useVaultEvents.backoff.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "#/offline/connectionStore";
import { nextBackoffMs, useVaultEvents } from "#/hooks/useVaultEvents";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();
  constructor(_url: string | URL) {
    FakeEventSource.instances.push(this);
  }
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  useConnectionStore.setState({ status: "connecting", disconnectedSince: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("nextBackoffMs", () => {
  it("doubles from 3s to a 60s cap with ±20% jitter", () => {
    const noJitter = () => 0.5;
    expect(nextBackoffMs(0, noJitter)).toBe(3000);
    expect(nextBackoffMs(1, noJitter)).toBe(6000);
    expect(nextBackoffMs(2, noJitter)).toBe(12000);
    expect(nextBackoffMs(10, noJitter)).toBe(60000);
    expect(nextBackoffMs(0, () => 0)).toBe(2400);
    expect(nextBackoffMs(0, () => 1)).toBe(3600);
  });
});

describe("useVaultEvents reconnect", () => {
  it("backs off between reconnect attempts and resets after a successful open", () => {
    const { unmount } = renderHook(() => useVaultEvents(), { wrapper });
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => FakeEventSource.instances[0]?.onerror?.(new Event("error")));
    act(() => vi.advanceTimersByTime(2399));
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(3601 - 2399));
    expect(FakeEventSource.instances).toHaveLength(2);

    act(() => FakeEventSource.instances[1]?.onerror?.(new Event("error")));
    act(() => vi.advanceTimersByTime(4799));
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(7201 - 4799));
    expect(FakeEventSource.instances).toHaveLength(3);

    act(() => FakeEventSource.instances[2]?.onopen?.(new Event("open")));
    act(() => FakeEventSource.instances[2]?.onerror?.(new Event("error")));
    act(() => vi.advanceTimersByTime(3601));
    expect(FakeEventSource.instances).toHaveLength(4);
    unmount();
  });

  it("writes status and disconnectedSince into the connection store", () => {
    vi.setSystemTime(new Date("2026-09-12T10:00:00Z"));
    const { unmount } = renderHook(() => useVaultEvents(), { wrapper });
    expect(useConnectionStore.getState().status).toBe("connecting");
    act(() => FakeEventSource.instances[0]?.onopen?.(new Event("open")));
    expect(useConnectionStore.getState()).toMatchObject({
      status: "connected",
      disconnectedSince: null,
    });
    act(() => FakeEventSource.instances[0]?.onerror?.(new Event("error")));
    expect(useConnectionStore.getState()).toMatchObject({
      status: "disconnected",
      disconnectedSince: Date.parse("2026-09-12T10:00:00Z"),
    });
    unmount();
  });

  it("does not reconnect while the browser is offline and reconnects on the online event", () => {
    const { unmount } = renderHook(() => useVaultEvents(), { wrapper });
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    act(() => FakeEventSource.instances[0]?.onerror?.(new Event("error")));
    act(() => vi.advanceTimersByTime(120_000));
    expect(FakeEventSource.instances).toHaveLength(1);

    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    act(() => window.dispatchEvent(new Event("online")));
    expect(FakeEventSource.instances).toHaveLength(2);
    unmount();
  });
});
```

`ui/src/hooks/useOnlineStatus.test.tsx`:

```tsx
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeOnline,
  SSE_DISCONNECT_GRACE_MS,
  useOnlineStatus,
} from "#/hooks/useOnlineStatus";
import { useConnectionStore } from "#/offline/connectionStore";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-12T10:00:00Z"));
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  useConnectionStore.setState({ status: "connected", disconnectedSince: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("computeOnline", () => {
  const now = Date.parse("2026-09-12T10:00:00Z");
  it("is offline whenever the browser says so", () => {
    expect(
      computeOnline({ navigatorOnline: false, status: "connected", disconnectedSince: null, now }),
    ).toBe(false);
  });
  it("tolerates a short SSE disconnect", () => {
    expect(
      computeOnline({
        navigatorOnline: true,
        status: "disconnected",
        disconnectedSince: now - SSE_DISCONNECT_GRACE_MS + 1,
        now,
      }),
    ).toBe(true);
  });
  it("is offline once the SSE disconnect outlives the grace period", () => {
    expect(
      computeOnline({
        navigatorOnline: true,
        status: "disconnected",
        disconnectedSince: now - SSE_DISCONNECT_GRACE_MS,
        now,
      }),
    ).toBe(false);
  });
  it("treats the initial connecting state as online", () => {
    expect(
      computeOnline({ navigatorOnline: true, status: "connecting", disconnectedSince: null, now }),
    ).toBe(true);
  });
});

describe("useOnlineStatus", () => {
  it("flips to offline after the grace period elapses without a reconnect", () => {
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
    act(() => {
      useConnectionStore.getState().setStatus("disconnected", Date.now());
    });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(SSE_DISCONNECT_GRACE_MS + 1));
    expect(result.current).toBe(false);
    act(() => useConnectionStore.getState().setStatus("connected"));
    expect(result.current).toBe(true);
  });

  it("follows the browser offline/online events", () => {
    const { result } = renderHook(() => useOnlineStatus());
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    act(() => window.dispatchEvent(new Event("offline")));
    expect(result.current).toBe(false);
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    act(() => window.dispatchEvent(new Event("online")));
    expect(result.current).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && bun run test src/hooks/useVaultEvents.backoff.test.tsx src/hooks/useOnlineStatus.test.tsx`
Expected: FAIL, missing modules/exports.

- [ ] **Step 3: Implement the store**

`ui/src/offline/connectionStore.ts`:

```ts
import { create } from "zustand";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface ConnectionState {
  status: ConnectionStatus;
  /** Epoch ms of the first error in the current disconnected stretch. */
  disconnectedSince: number | null;
  setStatus: (status: ConnectionStatus, now?: number) => void;
}

/**
 * The SSE stream's health, written by `useVaultEvents` and read by anything
 * that needs an online/offline answer without opening its own EventSource.
 */
export const useConnectionStore = create<ConnectionState>((set, get) => ({
  status: "connecting",
  disconnectedSince: null,
  setStatus: (status, now = Date.now()) => {
    if (status === "disconnected") {
      set({
        status,
        disconnectedSince: get().disconnectedSince ?? now,
      });
      return;
    }
    set({ status, disconnectedSince: null });
  },
}));
```

- [ ] **Step 4: Rework `useVaultEvents`**

Replace the top of `ui/src/hooks/useVaultEvents.ts` (imports, type export, hook shell) with the following; keep the `onmessage` invalidation body exactly as it is today.

```ts
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { clearBlockDetailsForPagePaths } from "#/api/blocks";
import { invalidateByPath, invalidateRubbish, queryKeys } from "#/api/keys";
import {
  type ConnectionStatus,
  useConnectionStore,
} from "#/offline/connectionStore";

export type { ConnectionStatus } from "#/offline/connectionStore";

export const SSE_BACKOFF = { initialMs: 3000, maxMs: 60_000, jitter: 0.2 };

/** Exponential backoff with ±jitter; `random` is injectable for tests. */
export function nextBackoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(
    SSE_BACKOFF.initialMs * 2 ** attempt,
    SSE_BACKOFF.maxMs,
  );
  const spread = (random() * 2 - 1) * SSE_BACKOFF.jitter;
  return Math.round(base * (1 + spread));
}

export function useVaultEvents(): ConnectionStatus {
  const queryClient = useQueryClient();
  const [status, setLocalStatus] = useState<ConnectionStatus>("connecting");
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const setStoreStatus = useConnectionStore((s) => s.setStatus);

  useEffect(() => {
    let es: EventSource | null = null;
    let disposed = false;
    let waitingForOnline = false;

    function setStatus(next: ConnectionStatus) {
      setLocalStatus(next);
      setStoreStatus(next);
    }

    function scheduleReconnect() {
      if (disposed) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        waitingForOnline = true;
        return;
      }
      const delay = nextBackoffMs(attemptRef.current);
      attemptRef.current += 1;
      retryTimeoutRef.current = setTimeout(connect, delay);
    }

    function connect() {
      if (disposed) return;
      waitingForOnline = false;
      setStatus("connecting");
      es = new EventSource("/api/vault/events");

      es.onopen = () => {
        if (disposed) return;
        attemptRef.current = 0;
        setStatus("connected");
      };

      es.onmessage = (event) => {
        // ... existing body unchanged ...
      };

      es.onerror = () => {
        if (disposed) return;
        setStatus("disconnected");
        es?.close();
        scheduleReconnect();
      };
    }

    function onOnline() {
      if (disposed || !waitingForOnline) return;
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
      connect();
    }

    window.addEventListener("online", onOnline);
    connect();

    return () => {
      disposed = true;
      window.removeEventListener("online", onOnline);
      es?.close();
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    };
  }, [queryClient, setStoreStatus]);

  return status;
}
```

Note: `useVaultEvents` is mounted twice today (`SyncIndicator` and `DesktopCodexFrame`), so two EventSources exist and both write the store. They observe the same server, so the store converges; a single shared connection is out of scope.

- [ ] **Step 5: Implement `useOnlineStatus`**

`ui/src/hooks/useOnlineStatus.ts`:

```ts
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  type ConnectionStatus,
  useConnectionStore,
} from "#/offline/connectionStore";

export const SSE_DISCONNECT_GRACE_MS = 10_000;

export function computeOnline(input: {
  navigatorOnline: boolean;
  status: ConnectionStatus;
  disconnectedSince: number | null;
  now: number;
}): boolean {
  if (!input.navigatorOnline) return false;
  if (input.status !== "disconnected" || input.disconnectedSince === null) {
    return true;
  }
  return input.now - input.disconnectedSince < SSE_DISCONNECT_GRACE_MS;
}

function subscribeNavigator(notify: () => void) {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
}

function readNavigatorOnline() {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

/** True when the browser is online and the SSE stream is healthy (10 s grace). */
export function useOnlineStatus(): boolean {
  const navigatorOnline = useSyncExternalStore(
    subscribeNavigator,
    readNavigatorOnline,
    () => true,
  );
  const status = useConnectionStore((s) => s.status);
  const disconnectedSince = useConnectionStore((s) => s.disconnectedSince);
  const [now, setNow] = useState(() => Date.now());

  // Re-evaluate once the grace period would expire.
  useEffect(() => {
    if (status !== "disconnected" || disconnectedSince === null) return;
    const remaining = disconnectedSince + SSE_DISCONNECT_GRACE_MS - Date.now();
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, remaining) + 1,
    );
    return () => clearTimeout(timer);
  }, [status, disconnectedSince]);

  return computeOnline({
    navigatorOnline,
    status,
    disconnectedSince,
    now: Math.max(now, Date.now()),
  });
}
```

- [ ] **Step 6: Run tests**

Run: `cd ui && bun run test src/hooks/useVaultEvents.backoff.test.tsx src/hooks/useOnlineStatus.test.tsx src/hooks/useVaultEvents.test.tsx src/hooks/useVaultEvents.integration.test.tsx src/components`
Expected: PASS. The two pre-existing `useVaultEvents` tests must still pass unchanged.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
cd ui && bun run typecheck && bun run lint
git add ui/src/offline/connectionStore.ts ui/src/hooks/useOnlineStatus.ts ui/src/hooks/useOnlineStatus.test.tsx ui/src/hooks/useVaultEvents.ts ui/src/hooks/useVaultEvents.backoff.test.tsx
git commit -m "feat(ui): connection store, SSE reconnect backoff, useOnlineStatus"
```

---

### Task 5: Offline store, walk set, and the sync walker

**Files:**
- Create: `ui/src/offline/offlineStore.ts`, `ui/src/offline/walkSet.ts`, `ui/src/offline/sync.ts`, `ui/src/offline/testing/fakeCaches.ts`
- Test: `ui/src/offline/walkSet.test.ts`, `ui/src/offline/sync.test.ts`

**Interfaces:**
- Consumes: `fetchClient` from `#/api/client`, `API_CACHE_NAME` from Task 2.
- Produces:
  ```ts
  // offlineStore.ts
  export interface OfflineState { phase: "idle" | "running"; progress: { done: number; total: number }; lastFullSync: string | null; pageCount: number; lastError: string | null; }
  export const useOfflineStore: UseBoundStore<StoreApi<OfflineState & OfflineActions>>;
  // walkSet.ts
  export type WalkRequest = () => Promise<Response>;
  export const WALK_SET: ReadonlyArray<{ label: string; run: () => Promise<Response> }>;
  export function pageRequests(path: string): Array<{ label: string; run: () => Promise<Response> }>;
  export function pageCacheKeys(path: string): string[];   // absolute pathnames for pages/backlinks/outlinks
  // sync.ts
  export interface SyncDeps { caches: CacheStorage; now: () => number; isOnline: () => boolean; }
  export async function runFullSync(deps: SyncDeps): Promise<void>;
  export async function runDeltaSync(deps: SyncDeps, delta: { upserted: string[]; removed: string[] }): Promise<void>;
  export class OfflineSyncController { constructor(deps: SyncDeps); requestFull(): void; requestDelta(delta): void; dispose(): void; }
  export const WALKER_CONCURRENCY = 6; export const REQUEST_TIMEOUT_MS = 15_000; export const DELTA_COALESCE_MS = 2_000; export const FULL_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  export function invalidateOfflineIndexHook: registered by Task 6 via `onSyncComplete(listener)`.
  ```

- [ ] **Step 1: Fake Cache API helper**

`ui/src/offline/testing/fakeCaches.ts`:

```ts
/** Minimal in-memory CacheStorage for vitest (jsdom has none). */
export class FakeCache implements Pick<Cache, "match" | "put" | "delete" | "keys"> {
  readonly entries = new Map<string, Response>();

  private key(request: RequestInfo | URL): string {
    if (typeof request === "string") return new URL(request, "http://localhost").href;
    if (request instanceof URL) return request.href;
    return request.url;
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(this.key(request))?.clone();
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(this.key(request), response);
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(this.key(request));
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

export class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();

  async open(name: string): Promise<Cache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return cache as unknown as Cache;
  }

  async has(name: string) {
    return this.caches.has(name);
  }

  async delete(name: string) {
    return this.caches.delete(name);
  }

  async keys() {
    return [...this.caches.keys()];
  }

  async match(): Promise<Response | undefined> {
    return undefined;
  }

  asCacheStorage(): CacheStorage {
    return this as unknown as CacheStorage;
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
```

- [ ] **Step 2: Write the failing walk-set test**

`ui/src/offline/walkSet.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "#/offline/testing/fakeCaches";
import { pageCacheKeys, pageRequests, WALK_SET } from "#/offline/walkSet";

afterEach(() => vi.unstubAllGlobals());

async function collectUrls(runs: Array<{ run: () => Promise<Response> }>) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return jsonResponse({});
    }),
  );
  for (const item of runs) await item.run();
  return urls.map((u) => new URL(u, "http://localhost").pathname + new URL(u, "http://localhost").search);
}

describe("WALK_SET", () => {
  it("mirrors the exact query strings the ui hooks send", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const urls = await collectUrls(WALK_SET);
    expect(urls).toEqual(
      expect.arrayContaining([
        "/api/vault/folders/tree",
        "/api/vault/index/tags",
        "/api/vault/index/stats",
        "/api/vault/index/graph",
        "/api/vault/journal/today",
        "/api/vault/journal/recent?days=30",
        "/api/vault/ai-journal/today",
        "/api/vault/ai-journal/recent?days=30",
        "/api/vault/board",
        `/api/vault/agenda?today=${today}`,
        "/api/vault/tasks?status=todo&sort=agenda&limit=8",
        "/api/vault/bases",
        "/api/features",
        "/api/vault/pages",
      ]),
    );
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe("pageRequests", () => {
  it("fetches the page, backlinks, and outlinks with encoded paths", async () => {
    const urls = await collectUrls(pageRequests("notes/a b.md"));
    expect(urls).toEqual([
      "/api/vault/pages/notes%2Fa%20b.md",
      "/api/vault/index/backlinks/notes%2Fa%20b.md",
      "/api/vault/index/outlinks/notes%2Fa%20b.md",
    ]);
    expect(pageCacheKeys("notes/a b.md")).toEqual([
      "/api/vault/pages/notes%2Fa%20b.md",
      "/api/vault/index/backlinks/notes%2Fa%20b.md",
      "/api/vault/index/outlinks/notes%2Fa%20b.md",
    ]);
  });
});
```

Before finalising the expected list, verify each derived-view query shape against its hook: `useJournalRecent`/`useAiJournalRecent` default `days` (`ui/src/api/journal.ts`, `ui/src/api/aiJournal.ts`), `useAgenda` `today` param (`ui/src/api/tasks.ts:24-28`), `AGENDA_FILTERS` in `ui/src/components/codex/AgendaTile.tsx:11`, the board hook in `ui/src/api/board.ts`. If a hook sends a different shape, change BOTH the test expectation and `WALK_SET` to the hook's shape; the hook is the source of truth. `journal/recent?days=30` is a placeholder for whatever the journal route's `days` default is: read it and pin the real value.

- [ ] **Step 3: Implement the walk set**

`ui/src/offline/walkSet.ts`:

```ts
import { fetchClient } from "#/api/client";

export interface WalkItem {
  label: string;
  run: () => Promise<Response>;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Derived views to keep warm. Each entry MUST send exactly the query string
 * its ui hook sends, otherwise the cache entry is never hit by navigation.
 * Cross-reference: journal.ts, aiJournal.ts, tasks.ts, AgendaTile.tsx, board.ts,
 * folders.ts, index.ts, bases.ts, features.ts, pages.ts.
 */
export const WALK_SET: ReadonlyArray<WalkItem> = [
  { label: "pages", run: () => fetchClient.GET("/api/vault/pages").then((r) => r.response) },
  { label: "folders/tree", run: () => fetchClient.GET("/api/vault/folders/tree").then((r) => r.response) },
  { label: "index/tags", run: () => fetchClient.GET("/api/vault/index/tags").then((r) => r.response) },
  { label: "index/stats", run: () => fetchClient.GET("/api/vault/index/stats").then((r) => r.response) },
  { label: "index/graph", run: () => fetchClient.GET("/api/vault/index/graph").then((r) => r.response) },
  { label: "journal/today", run: () => fetchClient.GET("/api/vault/journal/today").then((r) => r.response) },
  {
    label: "journal/recent",
    run: () =>
      fetchClient
        .GET("/api/vault/journal/recent", { params: { query: { days: 30 } } })
        .then((r) => r.response),
  },
  { label: "ai-journal/today", run: () => fetchClient.GET("/api/vault/ai-journal/today").then((r) => r.response) },
  {
    label: "ai-journal/recent",
    run: () =>
      fetchClient
        .GET("/api/vault/ai-journal/recent", { params: { query: { days: 30 } } })
        .then((r) => r.response),
  },
  { label: "board", run: () => fetchClient.GET("/api/vault/board").then((r) => r.response) },
  {
    label: "agenda",
    run: () =>
      fetchClient
        .GET("/api/vault/agenda", { params: { query: { today: today() } } })
        .then((r) => r.response),
  },
  {
    label: "tasks (agenda tile)",
    run: () =>
      fetchClient
        .GET("/api/vault/tasks", {
          params: { query: { status: "todo", sort: "agenda", limit: 8 } },
        })
        .then((r) => r.response),
  },
  { label: "bases", run: () => fetchClient.GET("/api/vault/bases").then((r) => r.response) },
  { label: "features", run: () => fetchClient.GET("/api/features").then((r) => r.response) },
];

export function pageRequests(path: string): WalkItem[] {
  const params = { params: { path: { path } } };
  return [
    { label: `page ${path}`, run: () => fetchClient.GET("/api/vault/pages/{path}", params).then((r) => r.response) },
    { label: `backlinks ${path}`, run: () => fetchClient.GET("/api/vault/index/backlinks/{path}", params).then((r) => r.response) },
    { label: `outlinks ${path}`, run: () => fetchClient.GET("/api/vault/index/outlinks/{path}", params).then((r) => r.response) },
  ];
}

/** Cache keys (pathname only) the three per-page requests produce. */
export function pageCacheKeys(path: string): string[] {
  const encoded = encodeURIComponent(path);
  return [
    `/api/vault/pages/${encoded}`,
    `/api/vault/index/backlinks/${encoded}`,
    `/api/vault/index/outlinks/${encoded}`,
  ];
}

export const PAGE_KEY_PREFIXES = [
  "/api/vault/pages/",
  "/api/vault/index/backlinks/",
  "/api/vault/index/outlinks/",
];
```

If the exact hook shapes differ from the above (Step 2 verification), adjust here too. If any `fetchClient.GET` call fails typecheck because the route's query params are typed differently (for example `status` is an enum), match the hook's literal types.

- [ ] **Step 4: Run walk-set test**

Run: `cd ui && bun run test src/offline/walkSet.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing sync tests**

`ui/src/offline/sync.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOfflineStore } from "#/offline/offlineStore";
import {
  DELTA_COALESCE_MS,
  OfflineSyncController,
  onSyncComplete,
  runDeltaSync,
  runFullSync,
  type SyncDeps,
  WALKER_CONCURRENCY,
} from "#/offline/sync";
import { FakeCacheStorage, jsonResponse } from "#/offline/testing/fakeCaches";
import { API_CACHE_NAME } from "#/offline/swPolicy";

const PAGES = ["notes/a.md", "notes/b.md", "proj/c.md"];

function pathOf(input: RequestInfo | URL): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url, "http://localhost");
  return u.pathname + u.search;
}

let calls: string[];
let inFlight: number;
let maxInFlight: number;
let release: Array<() => void>;

function installFetch(options: { hold?: boolean; failOn?: (path: string) => boolean } = {}) {
  calls = [];
  inFlight = 0;
  maxInFlight = 0;
  release = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      calls.push(path);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (options.hold) {
        await new Promise<void>((resolve) => release.push(resolve));
      }
      inFlight -= 1;
      if (options.failOn?.(path)) throw new TypeError("network down");
      if (path === "/api/vault/pages") {
        return jsonResponse({
          items: PAGES.map((p) => ({ path: p })),
          total: PAGES.length,
          offset: 0,
          limit: null,
        });
      }
      return jsonResponse({ path });
    }),
  );
}

function deps(overrides: Partial<SyncDeps> = {}): SyncDeps & { storage: FakeCacheStorage } {
  const storage = new FakeCacheStorage();
  return {
    storage,
    caches: storage.asCacheStorage(),
    now: () => Date.parse("2026-09-12T10:00:00Z"),
    isOnline: () => true,
    ...overrides,
  };
}

beforeEach(() => {
  useOfflineStore.setState({
    phase: "idle",
    progress: { done: 0, total: 0 },
    lastFullSync: null,
    pageCount: 0,
    lastError: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("runFullSync", () => {
  it("lists pages, then fetches the per-page triple and the derived set", async () => {
    installFetch();
    await runFullSync(deps());
    expect(calls[0]).toBe("/api/vault/pages");
    for (const p of PAGES) {
      const enc = encodeURIComponent(p);
      expect(calls).toContain(`/api/vault/pages/${enc}`);
      expect(calls).toContain(`/api/vault/index/backlinks/${enc}`);
      expect(calls).toContain(`/api/vault/index/outlinks/${enc}`);
    }
    expect(calls).toContain("/api/vault/folders/tree");
    expect(calls).toContain("/api/vault/board");
    expect(useOfflineStore.getState()).toMatchObject({
      phase: "idle",
      pageCount: 3,
      lastFullSync: "2026-09-12T10:00:00.000Z",
      lastError: null,
    });
    expect(useOfflineStore.getState().progress.done).toBe(
      useOfflineStore.getState().progress.total,
    );
  });

  it("never exceeds the concurrency ceiling", async () => {
    installFetch({ hold: true });
    const run = runFullSync(deps());
    // Let the list request resolve first.
    await vi.waitFor(() => expect(release.length).toBeGreaterThan(0));
    release.shift()?.();
    await vi.waitFor(() => expect(release.length).toBe(WALKER_CONCURRENCY));
    expect(maxInFlight).toBeLessThanOrEqual(WALKER_CONCURRENCY);
    while (release.length > 0 || inFlight > 0) {
      release.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }
    await run;
    expect(maxInFlight).toBe(WALKER_CONCURRENCY);
  });

  it("prunes page-scoped cache entries for pages that no longer exist", async () => {
    installFetch();
    const d = deps();
    const cache = await d.storage.open(API_CACHE_NAME);
    await cache.put("http://localhost/api/vault/pages/gone.md", jsonResponse({}));
    await cache.put("http://localhost/api/vault/index/backlinks/gone.md", jsonResponse({}));
    await cache.put("http://localhost/api/vault/pages/notes%2Fa.md", jsonResponse({}));
    await cache.put("http://localhost/api/vault/journal/recent?days=7", jsonResponse({}));
    await runFullSync(d);
    const keys = (await cache.keys()).map((r) => new URL(r.url).pathname);
    expect(keys).not.toContain("/api/vault/pages/gone.md");
    expect(keys).not.toContain("/api/vault/index/backlinks/gone.md");
    expect(keys).toContain("/api/vault/pages/notes%2Fa.md");
    expect(keys).toContain("/api/vault/journal/recent");
  });

  it("counts failures without aborting and records the last error", async () => {
    installFetch({ failOn: (p) => p.includes("backlinks") });
    await runFullSync(deps());
    expect(calls.filter((p) => p.includes("outlinks"))).toHaveLength(3);
    expect(useOfflineStore.getState().lastError).toMatch(/3 request/);
    expect(useOfflineStore.getState().lastFullSync).not.toBeNull();
  });

  it("does nothing while offline", async () => {
    installFetch();
    await runFullSync(deps({ isOnline: () => false }));
    expect(calls).toHaveLength(0);
    expect(useOfflineStore.getState().phase).toBe("idle");
  });

  it("notifies completion listeners", async () => {
    installFetch();
    const listener = vi.fn();
    const off = onSyncComplete(listener);
    await runFullSync(deps());
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("runDeltaSync", () => {
  it("refetches upserted pages, deletes removed ones, and refreshes derived views", async () => {
    installFetch();
    const d = deps();
    const cache = await d.storage.open(API_CACHE_NAME);
    await cache.put("http://localhost/api/vault/pages/old.md", jsonResponse({}));
    await cache.put("http://localhost/api/vault/index/outlinks/old.md", jsonResponse({}));
    await runDeltaSync(d, { upserted: ["notes/a.md"], removed: ["old.md"] });
    expect(calls).toContain("/api/vault/pages/notes%2Fa.md");
    expect(calls).toContain("/api/vault/index/backlinks/notes%2Fa.md");
    expect(calls).toContain("/api/vault/index/outlinks/notes%2Fa.md");
    expect(calls).not.toContain("/api/vault/pages/notes%2Fb.md");
    expect(calls).toContain("/api/vault/folders/tree");
    const keys = (await cache.keys()).map((r) => new URL(r.url).pathname);
    expect(keys).not.toContain("/api/vault/pages/old.md");
    expect(keys).not.toContain("/api/vault/index/outlinks/old.md");
    expect(useOfflineStore.getState().lastFullSync).toBeNull();
  });
});

describe("OfflineSyncController", () => {
  it("coalesces a burst of deltas into one pass", async () => {
    vi.useFakeTimers();
    installFetch();
    const controller = new OfflineSyncController(deps());
    controller.requestDelta({ upserted: ["notes/a.md"], removed: [] });
    controller.requestDelta({ upserted: ["notes/b.md"], removed: [] });
    await vi.advanceTimersByTimeAsync(DELTA_COALESCE_MS - 1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    await vi.runAllTimersAsync();
    expect(calls.filter((p) => p.startsWith("/api/vault/pages/"))).toEqual(
      expect.arrayContaining(["/api/vault/pages/notes%2Fa.md", "/api/vault/pages/notes%2Fb.md"]),
    );
    expect(calls.filter((p) => p === "/api/vault/folders/tree")).toHaveLength(1);
    controller.dispose();
  });

  it("runs one pass at a time and reruns once if asked mid-pass", async () => {
    vi.useFakeTimers();
    installFetch({ hold: true });
    const controller = new OfflineSyncController(deps());
    controller.requestFull();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(release.length).toBeGreaterThan(0));
    controller.requestFull();
    controller.requestFull();
    while (release.length > 0 || inFlight > 0) {
      release.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(DELTA_COALESCE_MS + 1);
    while (release.length > 0 || inFlight > 0) {
      release.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(calls.filter((p) => p === "/api/vault/pages")).toHaveLength(2);
    controller.dispose();
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `cd ui && bun run test src/offline/sync.test.ts`
Expected: FAIL, missing modules.

- [ ] **Step 7: Implement the store**

`ui/src/offline/offlineStore.ts`:

```ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface OfflineState {
  phase: "idle" | "running";
  progress: { done: number; total: number };
  /** ISO timestamp of the last completed full pass, or null if never. */
  lastFullSync: string | null;
  pageCount: number;
  lastError: string | null;
}

export interface OfflineActions {
  start: (total: number) => void;
  advance: () => void;
  finishFull: (input: { at: string; pageCount: number; error: string | null }) => void;
  finishDelta: (input: { error: string | null }) => void;
}

export const useOfflineStore = create<OfflineState & OfflineActions>()(
  persist(
    (set) => ({
      phase: "idle",
      progress: { done: 0, total: 0 },
      lastFullSync: null,
      pageCount: 0,
      lastError: null,

      start: (total) =>
        set({ phase: "running", progress: { done: 0, total }, lastError: null }),
      advance: () =>
        set((s) => ({
          progress: { done: s.progress.done + 1, total: s.progress.total },
        })),
      finishFull: ({ at, pageCount, error }) =>
        set({ phase: "idle", lastFullSync: at, pageCount, lastError: error }),
      finishDelta: ({ error }) => set({ phase: "idle", lastError: error }),
    }),
    {
      name: "clepsydra-offline",
      partialize: (s) => ({ lastFullSync: s.lastFullSync, pageCount: s.pageCount }),
    },
  ),
);
```

- [ ] **Step 8: Implement the walker**

`ui/src/offline/sync.ts`:

```ts
import { useOfflineStore } from "#/offline/offlineStore";
import { API_CACHE_NAME } from "#/offline/swPolicy";
import {
  PAGE_KEY_PREFIXES,
  pageCacheKeys,
  pageRequests,
  WALK_SET,
  type WalkItem,
} from "#/offline/walkSet";

export const WALKER_CONCURRENCY = 6;
export const REQUEST_TIMEOUT_MS = 15_000;
export const DELTA_COALESCE_MS = 2_000;
export const LAUNCH_DELAY_MS = 3_000;
export const FULL_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SyncDeps {
  caches: CacheStorage;
  now: () => number;
  isOnline: () => boolean;
}

type Listener = () => void;
const completeListeners = new Set<Listener>();

/** Subscribe to "a pass finished" (used by the offline search index). */
export function onSyncComplete(listener: Listener): () => void {
  completeListeners.add(listener);
  return () => completeListeners.delete(listener);
}

function notifyComplete() {
  for (const listener of completeListeners) listener();
}

async function withTimeout(item: WalkItem): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timeout: ${item.label}`)),
      REQUEST_TIMEOUT_MS,
    );
  });
  try {
    const response = await Promise.race([item.run(), timeout]);
    return response.ok;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run items with at most WALKER_CONCURRENCY in flight; returns failure count. */
async function runPool(items: WalkItem[]): Promise<number> {
  const store = useOfflineStore.getState();
  let next = 0;
  let failures = 0;
  async function worker() {
    while (next < items.length) {
      const item = items[next++];
      if (!item) return;
      const ok = await withTimeout(item);
      if (!ok) failures += 1;
      store.advance();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(WALKER_CONCURRENCY, items.length) }, worker),
  );
  return failures;
}

async function listPagePaths(): Promise<string[] | null> {
  const list = WALK_SET.find((item) => item.label === "pages");
  if (!list) return null;
  try {
    const response = await list.run();
    if (!response.ok) return null;
    const body = (await response.clone().json()) as { items: Array<{ path: string }> };
    return body.items.map((item) => item.path);
  } catch {
    return null;
  }
}

async function pruneMissingPages(caches: CacheStorage, keep: Set<string>) {
  const cache = await caches.open(API_CACHE_NAME);
  const keepKeys = new Set([...keep].flatMap(pageCacheKeys));
  for (const request of await cache.keys()) {
    const pathname = new URL(request.url).pathname;
    const pageScoped = PAGE_KEY_PREFIXES.some((p) => pathname.startsWith(p));
    if (pageScoped && !keepKeys.has(pathname)) await cache.delete(request);
  }
}

async function deletePages(caches: CacheStorage, paths: string[]) {
  const cache = await caches.open(API_CACHE_NAME);
  for (const request of await cache.keys()) {
    const pathname = new URL(request.url).pathname;
    if (paths.some((p) => pageCacheKeys(p).includes(pathname))) {
      await cache.delete(request);
    }
  }
}

function errorSummary(failures: number): string | null {
  return failures === 0 ? null : `${failures} request${failures === 1 ? "" : "s"} failed`;
}

export async function runFullSync(deps: SyncDeps): Promise<void> {
  if (!deps.isOnline()) return;
  const store = useOfflineStore.getState();
  const paths = await listPagePaths();
  if (paths === null) {
    store.finishDelta({ error: "page list unavailable" });
    return;
  }
  const items = [
    ...paths.flatMap(pageRequests),
    ...WALK_SET.filter((item) => item.label !== "pages"),
  ];
  store.start(items.length);
  const failures = await runPool(items);
  await pruneMissingPages(deps.caches, new Set(paths));
  useOfflineStore.getState().finishFull({
    at: new Date(deps.now()).toISOString(),
    pageCount: paths.length,
    error: errorSummary(failures),
  });
  notifyComplete();
}

export async function runDeltaSync(
  deps: SyncDeps,
  delta: { upserted: string[]; removed: string[] },
): Promise<void> {
  if (!deps.isOnline()) return;
  const store = useOfflineStore.getState();
  const items = [...delta.upserted.flatMap(pageRequests), ...WALK_SET];
  store.start(items.length);
  const failures = await runPool(items);
  if (delta.removed.length > 0) await deletePages(deps.caches, delta.removed);
  useOfflineStore.getState().finishDelta({ error: errorSummary(failures) });
  notifyComplete();
}

/**
 * Serialises passes: one at a time, deltas coalesced for DELTA_COALESCE_MS,
 * a request during a pass queues exactly one follow-up pass.
 */
export class OfflineSyncController {
  private running = false;
  private pendingFull = false;
  private pendingDelta: { upserted: Set<string>; removed: Set<string> } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly deps: SyncDeps) {}

  requestFull() {
    this.pendingFull = true;
    this.schedule(0);
  }

  requestDelta(delta: { upserted: string[]; removed: string[] }) {
    this.pendingDelta ??= { upserted: new Set(), removed: new Set() };
    for (const p of delta.upserted) this.pendingDelta.upserted.add(p);
    for (const p of delta.removed) this.pendingDelta.removed.add(p);
    this.schedule(DELTA_COALESCE_MS);
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delay: number) {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delay);
  }

  private async drain() {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (!this.disposed && (this.pendingFull || this.pendingDelta)) {
        if (this.pendingFull) {
          this.pendingFull = false;
          this.pendingDelta = null; // a full pass subsumes any delta
          await runFullSync(this.deps);
        } else if (this.pendingDelta) {
          const delta = this.pendingDelta;
          this.pendingDelta = null;
          await runDeltaSync(this.deps, {
            upserted: [...delta.upserted],
            removed: [...delta.removed],
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
```

- [ ] **Step 9: Run tests**

Run: `cd ui && bun run test src/offline`
Expected: PASS. If the concurrency test is flaky under load, loosen only the `toBe(WALKER_CONCURRENCY)` assertion to `toBeLessThanOrEqual` and keep the `waitFor(release.length === 6)` assertion, which is the real ceiling check.

- [ ] **Step 10: Typecheck, lint, commit**

```bash
cd ui && bun run typecheck && bun run lint
git add ui/src/offline/offlineStore.ts ui/src/offline/walkSet.ts ui/src/offline/walkSet.test.ts ui/src/offline/sync.ts ui/src/offline/sync.test.ts ui/src/offline/testing/fakeCaches.ts
git commit -m "feat(ui): offline sync walker, walk set, and offline store"
```

---

### Task 6: Wire the walker: launch, SSE deltas, Settings "Sync now"

**Files:**
- Create: `ui/src/offline/useOfflineSync.ts`, `ui/src/components/settings/OfflinePanel.tsx`
- Modify: `ui/src/hooks/useVaultEvents.ts` (emit deltas), `ui/src/routes/__root.tsx` (mount), `ui/src/components/SettingsModal.tsx` (panel)
- Test: `ui/src/offline/useOfflineSync.test.tsx`, `ui/src/components/settings/OfflinePanel.test.tsx`

**Interfaces:**
- Consumes: `OfflineSyncController`, `LAUNCH_DELAY_MS`, `FULL_SYNC_MAX_AGE_MS` (Task 5); `useOnlineStatus` (Task 4).
- Produces:
  ```ts
  // useOfflineSync.ts
  export function useOfflineSync(): { syncNow: () => void };      // mounted once in __root
  export function requestOfflineSyncNow(): void;                   // module-level, for Settings
  // connectionStore.ts gains:
  //   indexDeltaListeners: subscribe via `onIndexChanged(listener: (delta) => void): () => void`
  ```

- [ ] **Step 1: Delta broadcast from `useVaultEvents`**

Add to `ui/src/offline/connectionStore.ts`:

```ts
export interface IndexDelta {
  upserted: string[];
  removed: string[];
}

type DeltaListener = (delta: IndexDelta) => void;
const deltaListeners = new Set<DeltaListener>();

export function onIndexChanged(listener: DeltaListener): () => void {
  deltaListeners.add(listener);
  return () => deltaListeners.delete(listener);
}

export function emitIndexChanged(delta: IndexDelta) {
  for (const listener of deltaListeners) listener(delta);
}
```

In `ui/src/hooks/useVaultEvents.ts`, inside the `index_changed` branch of `onmessage`, add as the first statement:

```ts
            emitIndexChanged({ upserted: data.upserted, removed: data.removed });
```
(import `emitIndexChanged` from `#/offline/connectionStore`).

- [ ] **Step 2: Write the failing hook test**

`ui/src/offline/useOfflineSync.test.tsx`:

```tsx
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitIndexChanged, useConnectionStore } from "#/offline/connectionStore";
import { useOfflineStore } from "#/offline/offlineStore";
import { LAUNCH_DELAY_MS, DELTA_COALESCE_MS } from "#/offline/sync";
import { FakeCacheStorage } from "#/offline/testing/fakeCaches";
import { requestOfflineSyncNow, useOfflineSync } from "#/offline/useOfflineSync";

const runFullSync = vi.hoisted(() => vi.fn(async () => {}));
const runDeltaSync = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("#/offline/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/offline/sync")>();
  return { ...actual, runFullSync, runDeltaSync };
});

beforeEach(() => {
  vi.useFakeTimers();
  runFullSync.mockClear();
  runDeltaSync.mockClear();
  vi.stubGlobal("caches", new FakeCacheStorage().asCacheStorage());
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  useConnectionStore.setState({ status: "connected", disconnectedSince: null });
  useOfflineStore.setState({ lastFullSync: null, pageCount: 0, phase: "idle", progress: { done: 0, total: 0 }, lastError: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useOfflineSync", () => {
  it("runs a full pass shortly after launch when there is no offline copy", async () => {
    const { unmount } = renderHook(() => useOfflineSync());
    await vi.advanceTimersByTimeAsync(LAUNCH_DELAY_MS - 1);
    expect(runFullSync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(runFullSync).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("skips the launch pass when the copy is fresh", async () => {
    useOfflineStore.setState({ lastFullSync: new Date().toISOString() });
    const { unmount } = renderHook(() => useOfflineSync());
    await vi.advanceTimersByTimeAsync(LAUNCH_DELAY_MS + 10);
    expect(runFullSync).not.toHaveBeenCalled();
    unmount();
  });

  it("runs a full pass at launch when the copy is older than a day", async () => {
    useOfflineStore.setState({
      lastFullSync: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const { unmount } = renderHook(() => useOfflineSync());
    await vi.advanceTimersByTimeAsync(LAUNCH_DELAY_MS + 10);
    expect(runFullSync).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("turns index_changed events into delta passes", async () => {
    useOfflineStore.setState({ lastFullSync: new Date().toISOString() });
    const { unmount } = renderHook(() => useOfflineSync());
    emitIndexChanged({ upserted: ["a.md"], removed: [] });
    await vi.advanceTimersByTimeAsync(DELTA_COALESCE_MS + 10);
    expect(runDeltaSync).toHaveBeenCalledWith(
      expect.anything(),
      { upserted: ["a.md"], removed: [] },
    );
    unmount();
  });

  it("exposes syncNow and a module-level trigger", async () => {
    useOfflineStore.setState({ lastFullSync: new Date().toISOString() });
    const { result, unmount } = renderHook(() => useOfflineSync());
    result.current.syncNow();
    await vi.advanceTimersByTimeAsync(10);
    expect(runFullSync).toHaveBeenCalledTimes(1);
    requestOfflineSyncNow();
    await vi.advanceTimersByTimeAsync(10);
    expect(runFullSync).toHaveBeenCalledTimes(2);
    unmount();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd ui && bun run test src/offline/useOfflineSync.test.tsx`
Expected: FAIL, missing module.

- [ ] **Step 4: Implement the hook**

`ui/src/offline/useOfflineSync.ts`:

```ts
import { useEffect, useMemo } from "react";
import { useOnlineStatus } from "#/hooks/useOnlineStatus";
import { onIndexChanged, useConnectionStore } from "#/offline/connectionStore";
import { useOfflineStore } from "#/offline/offlineStore";
import {
  FULL_SYNC_MAX_AGE_MS,
  LAUNCH_DELAY_MS,
  OfflineSyncController,
} from "#/offline/sync";
import { computeOnline } from "#/hooks/useOnlineStatus";

let activeController: OfflineSyncController | null = null;

/** Settings "Sync now" reaches the mounted controller through this. */
export function requestOfflineSyncNow() {
  activeController?.requestFull();
}

function isOnlineNow(): boolean {
  const { status, disconnectedSince } = useConnectionStore.getState();
  return computeOnline({
    navigatorOnline: typeof navigator === "undefined" ? true : navigator.onLine !== false,
    status,
    disconnectedSince,
    now: Date.now(),
  });
}

function copyIsStale(lastFullSync: string | null): boolean {
  if (!lastFullSync) return true;
  return Date.now() - Date.parse(lastFullSync) > FULL_SYNC_MAX_AGE_MS;
}

/**
 * Mount once (root route). Owns the walker controller for the page session:
 * launch pass, SSE deltas, and the shared "sync now" entry point.
 */
export function useOfflineSync(): { syncNow: () => void } {
  const online = useOnlineStatus();
  const controller = useMemo(
    () =>
      new OfflineSyncController({
        caches: globalThis.caches,
        now: () => Date.now(),
        isOnline: isOnlineNow,
      }),
    [],
  );

  useEffect(() => {
    activeController = controller;
    const offDelta = onIndexChanged((delta) => controller.requestDelta(delta));
    const launch = setTimeout(() => {
      if (copyIsStale(useOfflineStore.getState().lastFullSync)) {
        controller.requestFull();
      }
    }, LAUNCH_DELAY_MS);
    return () => {
      clearTimeout(launch);
      offDelta();
      controller.dispose();
      if (activeController === controller) activeController = null;
    };
  }, [controller]);

  // Coming back online after a stale stretch: refresh the copy.
  useEffect(() => {
    if (online && copyIsStale(useOfflineStore.getState().lastFullSync)) {
      controller.requestFull();
    }
  }, [online, controller]);

  return { syncNow: () => controller.requestFull() };
}
```

Guard: if `globalThis.caches` is undefined (insecure context, some test envs), the controller's prune calls would throw. In `sync.ts` `pruneMissingPages`/`deletePages`, wrap the `caches.open` in `if (!caches) return;`. Add that guard now.

- [ ] **Step 5: Mount in the root route**

In `ui/src/routes/__root.tsx`, import `useOfflineSync` from `#/offline/useOfflineSync` and call `useOfflineSync();` at the top of the root component that renders `<CodexFrame>` (the same component that mounts `GlobalShortcuts`). No JSX change.

- [ ] **Step 6: Settings panel with test**

`ui/src/components/settings/OfflinePanel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOfflineStore } from "#/offline/offlineStore";

const requestOfflineSyncNow = vi.hoisted(() => vi.fn());
vi.mock("#/offline/useOfflineSync", () => ({ requestOfflineSyncNow }));

import { OfflinePanel } from "#/components/settings/OfflinePanel";

beforeEach(() => {
  requestOfflineSyncNow.mockClear();
  useOfflineStore.setState({
    phase: "idle",
    progress: { done: 0, total: 0 },
    lastFullSync: "2026-09-12T14:02:00Z",
    pageCount: 252,
    lastError: null,
  });
});

describe("OfflinePanel", () => {
  it("describes the offline copy and triggers a sync", async () => {
    render(<OfflinePanel />);
    expect(screen.getByText(/252 pages/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(requestOfflineSyncNow).toHaveBeenCalledTimes(1);
  });

  it("shows progress while running and the last error", () => {
    useOfflineStore.setState({
      phase: "running",
      progress: { done: 40, total: 770 },
      lastError: "3 requests failed",
    });
    render(<OfflinePanel />);
    expect(screen.getByText(/40 \/ 770/)).toBeInTheDocument();
    expect(screen.getByText(/3 requests failed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Syncing/ })).toBeDisabled();
  });

  it("explains when there is no copy yet", () => {
    useOfflineStore.setState({ lastFullSync: null, pageCount: 0 });
    render(<OfflinePanel />);
    expect(screen.getByText(/No offline copy yet/)).toBeInTheDocument();
  });
});
```

`ui/src/components/settings/OfflinePanel.tsx`:

```tsx
import { Button } from "#/components/ui/button";
import { formatRelativeTime } from "#/lib/time";
import { useOfflineStore } from "#/offline/offlineStore";
import { requestOfflineSyncNow } from "#/offline/useOfflineSync";

export function OfflinePanel() {
  const phase = useOfflineStore((s) => s.phase);
  const progress = useOfflineStore((s) => s.progress);
  const lastFullSync = useOfflineStore((s) => s.lastFullSync);
  const pageCount = useOfflineStore((s) => s.pageCount);
  const lastError = useOfflineStore((s) => s.lastError);
  const running = phase === "running";

  const summary = lastFullSync
    ? `${pageCount} pages, synced ${formatRelativeTime(lastFullSync)}`
    : "No offline copy yet.";

  return (
    <div className="border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider">Offline copy</h4>
          <p className="mt-1 text-sm text-muted-foreground">
            The whole vault is kept readable on this device without a connection.
          </p>
          <p className="mt-2 text-sm">{summary}</p>
          {running && (
            <p className="mt-1 text-sm text-muted-foreground">
              Syncing {progress.done} / {progress.total}
            </p>
          )}
          {lastError && (
            <p className="mt-1 text-sm text-destructive">Last sync: {lastError}</p>
          )}
        </div>
        <Button
          variant="secondary"
          size="sm"
          isDisabled={running}
          onPress={() => requestOfflineSyncNow()}
        >
          {running ? "Syncing…" : "Sync now"}
        </Button>
      </div>
    </div>
  );
}
```

Check `formatRelativeTime`'s signature in `ui/src/lib/time.ts` (it is already imported by `SettingsModal.tsx`); pass what it expects (string or Date).

In `ui/src/components/SettingsModal.tsx`, import `OfflinePanel` from `#/components/settings/OfflinePanel` and render it after `<IndexHealthPanel />` in the advanced branch.

- [ ] **Step 7: Run tests**

Run: `cd ui && bun run test src/offline src/components/settings src/components/SettingsModal`
Expected: PASS.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
cd ui && bun run typecheck && bun run lint
git add ui/src/offline/connectionStore.ts ui/src/hooks/useVaultEvents.ts ui/src/offline/useOfflineSync.ts ui/src/offline/useOfflineSync.test.tsx ui/src/offline/sync.ts ui/src/routes/__root.tsx ui/src/components/settings/OfflinePanel.tsx ui/src/components/settings/OfflinePanel.test.tsx ui/src/components/SettingsModal.tsx
git commit -m "feat(ui): run the offline walker on launch, SSE deltas, and Sync now"
```

---

### Task 7: Offline search fallback

**Files:**
- Create: `ui/src/offline/search.ts`
- Modify: `ui/src/api/client.ts`, `ui/package.json` (minisearch)
- Test: `ui/src/offline/search.test.ts`

**Interfaces:**
- Consumes: `API_CACHE_NAME`, `isOfflineUncached` (Task 2); `onSyncComplete` (Task 5).
- Produces:
  ```ts
  export interface OfflineSearchHit { page_id: string; path: string; title: string | null; snippet: string; }
  export async function buildOfflineIndex(caches: CacheStorage): Promise<OfflineIndex>;
  export function invalidateOfflineIndex(): void;
  export async function searchOffline(q: string, limit: number | undefined, caches?: CacheStorage): Promise<OfflineSearchHit[]>;
  export const offlineSearchMiddleware: Middleware;   // from openapi-fetch
  ```

- [ ] **Step 1: Install**

```bash
cd ui && bun add minisearch@^7.2.0
```

- [ ] **Step 2: Write the failing tests**

`ui/src/offline/search.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOfflineIndex,
  invalidateOfflineIndex,
  offlineSearchMiddleware,
  searchOffline,
} from "#/offline/search";
import { API_CACHE_NAME, offlineUncachedResponse } from "#/offline/swPolicy";
import { FakeCacheStorage, jsonResponse } from "#/offline/testing/fakeCaches";

function page(path: string, extra: Record<string, unknown>) {
  return {
    path,
    canonical_name: path,
    meta: { id: `id-${path}`, title: null, aliases: [], tags: [] },
    computed_tags: [],
    body: "",
    revision: "r",
    kind: "note",
    inferred: true,
    readonly: false,
    encrypted: false,
    ...extra,
  };
}

let storage: FakeCacheStorage;

beforeEach(async () => {
  storage = new FakeCacheStorage();
  const cache = await storage.open(API_CACHE_NAME);
  await cache.put(
    "http://localhost/api/vault/pages/notes%2Fwater.md",
    jsonResponse(page("notes/water.md", { meta: { id: "id-1", title: "Water clocks", aliases: ["clepsydra"], tags: [] }, body: "A clepsydra measures time by the flow of water into a vessel." })),
  );
  await cache.put(
    "http://localhost/api/vault/pages/notes%2Fsand.md",
    jsonResponse(page("notes/sand.md", { meta: { id: "id-2", title: "Hourglass", aliases: [], tags: [] }, body: "Sand replaced water in later timekeeping devices." })),
  );
  await cache.put(
    "http://localhost/api/vault/pages/secret.md",
    jsonResponse(page("secret.md", { meta: { id: "id-3", title: "water secrets", aliases: [], tags: [] }, body: "age-encryption.org/v1", encrypted: true })),
  );
  await cache.put("http://localhost/api/vault/folders/tree", jsonResponse({ folders: [] }));
  invalidateOfflineIndex();
});

afterEach(() => vi.unstubAllGlobals());

describe("searchOffline", () => {
  it("returns SearchResultEntry-shaped hits with title matches ranked first", async () => {
    const hits = await searchOffline("water", undefined, storage.asCacheStorage());
    expect(hits[0]).toMatchObject({ page_id: "id-1", path: "notes/water.md", title: "Water clocks" });
    expect(hits.map((h) => h.path)).toEqual(["notes/water.md", "notes/sand.md"]);
    expect(hits[0]?.snippet).toMatch(/water/i);
    expect(hits[0]?.snippet.length).toBeLessThanOrEqual(200);
  });

  it("skips encrypted pages", async () => {
    const hits = await searchOffline("secrets", undefined, storage.asCacheStorage());
    expect(hits).toEqual([]);
  });

  it("respects limit and matches aliases", async () => {
    const hits = await searchOffline("clepsydra", 1, storage.asCacheStorage());
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("notes/water.md");
  });

  it("memoises the index until invalidated", async () => {
    const first = await buildOfflineIndex(storage.asCacheStorage());
    const second = await buildOfflineIndex(storage.asCacheStorage());
    expect(second).toBe(first);
    invalidateOfflineIndex();
    const third = await buildOfflineIndex(storage.asCacheStorage());
    expect(third).not.toBe(first);
  });
});

describe("offlineSearchMiddleware", () => {
  it("replaces an offline_uncached search response with local results", async () => {
    vi.stubGlobal("caches", storage.asCacheStorage());
    const request = new Request("http://localhost/api/vault/index/search?q=water&limit=5");
    const response = await offlineSearchMiddleware.onResponse?.({
      request,
      response: offlineUncachedResponse(request.url),
      schemaPath: "/api/vault/index/search",
      params: { query: { q: "water", limit: 5 } },
      id: "1",
      options: {} as never,
    } as never);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(200);
    const body = await (response as Response).json();
    expect(body[0]).toMatchObject({ path: "notes/water.md" });
  });

  it("leaves other responses alone", async () => {
    vi.stubGlobal("caches", storage.asCacheStorage());
    const request = new Request("http://localhost/api/vault/index/tags");
    const out = await offlineSearchMiddleware.onResponse?.({
      request,
      response: offlineUncachedResponse(request.url),
      schemaPath: "/api/vault/index/tags",
      params: {},
      id: "2",
      options: {} as never,
    } as never);
    expect(out).toBeUndefined();
  });

  it("answers from the local index on a network error (no service worker)", async () => {
    vi.stubGlobal("caches", storage.asCacheStorage());
    const request = new Request("http://localhost/api/vault/index/search?q=sand");
    const response = await offlineSearchMiddleware.onError?.({
      request,
      error: new TypeError("Failed to fetch"),
      schemaPath: "/api/vault/index/search",
      params: { query: { q: "sand" } },
      id: "3",
      options: {} as never,
    } as never);
    expect((response as Response).status).toBe(200);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd ui && bun run test src/offline/search.test.ts`
Expected: FAIL, missing module.

- [ ] **Step 4: Implement**

`ui/src/offline/search.ts`:

```ts
import MiniSearch from "minisearch";
import type { Middleware } from "openapi-fetch";
import type { components } from "#/api/schema";
import { API_CACHE_NAME, isOfflineUncached } from "#/offline/swPolicy";
import { onSyncComplete } from "#/offline/sync";

type PageDetail = components["schemas"]["PageDetailResponse"];

export interface OfflineSearchHit {
  page_id: string;
  path: string;
  title: string | null;
  snippet: string;
}

interface Doc {
  id: string;
  page_id: string;
  path: string;
  title: string;
  aliases: string;
  body: string;
}

export type OfflineIndex = MiniSearch<Doc>;

const SNIPPET_RADIUS = 80;
const DEFAULT_LIMIT = 20;

let cached: Promise<OfflineIndex> | null = null;

export function invalidateOfflineIndex() {
  cached = null;
}

onSyncComplete(invalidateOfflineIndex);

async function readCachedPages(caches: CacheStorage): Promise<PageDetail[]> {
  const cache = await caches.open(API_CACHE_NAME);
  const pages: PageDetail[] = [];
  for (const request of await cache.keys()) {
    if (!new URL(request.url).pathname.startsWith("/api/vault/pages/")) continue;
    const response = await cache.match(request);
    if (!response) continue;
    try {
      const page = (await response.json()) as PageDetail;
      if (page.encrypted || typeof page.body !== "string") continue;
      pages.push(page);
    } catch {
      // A cached non-JSON or partial entry; skip it.
    }
  }
  return pages;
}

function newIndex(): OfflineIndex {
  return new MiniSearch<Doc>({
    fields: ["title", "aliases", "path", "body"],
    storeFields: ["page_id", "path", "title", "body"],
    searchOptions: {
      prefix: true,
      fuzzy: 0.2,
      boost: { title: 3, aliases: 2 },
    },
  });
}

export function buildOfflineIndex(caches: CacheStorage): Promise<OfflineIndex> {
  cached ??= (async () => {
    const index = newIndex();
    const pages = await readCachedPages(caches);
    index.addAll(
      pages.map((page) => ({
        id: page.path,
        page_id: page.meta.id,
        path: page.path,
        title: page.meta.title ?? "",
        aliases: (page.meta.aliases ?? []).join(" "),
        body: page.body,
      })),
    );
    return index;
  })();
  return cached;
}

function snippetFor(body: string, terms: string[]): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    at = lower.indexOf(term.toLowerCase());
    if (at >= 0) break;
  }
  if (at < 0) return flat.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(flat.length, at + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export async function searchOffline(
  q: string,
  limit: number | undefined,
  caches: CacheStorage = globalThis.caches,
): Promise<OfflineSearchHit[]> {
  const query = q.trim();
  if (!query || !caches) return [];
  const index = await buildOfflineIndex(caches);
  const terms = query.split(/\s+/);
  return index
    .search(query)
    .slice(0, limit ?? DEFAULT_LIMIT)
    .map((hit) => ({
      page_id: String(hit.page_id),
      path: String(hit.path),
      title: hit.title ? String(hit.title) : null,
      snippet: snippetFor(String(hit.body ?? ""), terms),
    }));
}

function isSearchRequest(schemaPath: string): boolean {
  return schemaPath === "/api/vault/index/search";
}

async function localResponse(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const hits = await searchOffline(
    url.searchParams.get("q") ?? "",
    limitParam ? Number(limitParam) : undefined,
  );
  return new Response(JSON.stringify(hits), {
    status: 200,
    headers: { "content-type": "application/json", "x-clepsydra-offline": "1" },
  });
}

/**
 * When the server cannot answer a search (service worker returned
 * offline_uncached, or fetch itself failed), answer from the cached vault.
 */
export const offlineSearchMiddleware: Middleware = {
  async onResponse({ request, response, schemaPath }) {
    if (!isSearchRequest(schemaPath) || response.status !== 503) return undefined;
    let body: unknown;
    try {
      body = await response.clone().json();
    } catch {
      return undefined;
    }
    if (!isOfflineUncached(body)) return undefined;
    return localResponse(request);
  },
  async onError({ request, schemaPath }) {
    if (!isSearchRequest(schemaPath)) return undefined;
    if (typeof globalThis.caches === "undefined") return undefined;
    return localResponse(request);
  },
};
```

`ui/src/api/client.ts`:

```ts
import createFetchClient from "openapi-fetch";
import createClient from "openapi-react-query";
import { offlineSearchMiddleware } from "#/offline/search";
import type { paths } from "./schema";

/** Raw openapi-fetch client for imperative (non-hook) calls. */
export const fetchClient = createFetchClient<paths>({ baseUrl: "/" });
fetchClient.use(offlineSearchMiddleware);
export const $api = createClient(fetchClient);
```

Circular import check: `search.ts` → `sync.ts` → `walkSet.ts` → `client.ts` → `search.ts`. Break it: `search.ts` must NOT import `sync.ts`. Instead, `sync.ts` imports `invalidateOfflineIndex` from `search.ts` and calls it inside `notifyComplete()`. Remove `onSyncComplete(invalidateOfflineIndex)` from `search.ts` and add `invalidateOfflineIndex();` as the first line of `notifyComplete()` in `sync.ts`. The `onSyncComplete` listener API stays for the memo test only.

- [ ] **Step 5: Run tests**

Run: `cd ui && bun run test src/offline src/api`
Expected: PASS. If MiniSearch ranks `notes/sand.md` above `notes/water.md` for "water", raise `boost.title` to 5; the title-match-first expectation is the contract.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
cd ui && bun run typecheck && bun run lint
git add ui/package.json ui/bun.lock ui/src/offline/search.ts ui/src/offline/search.test.ts ui/src/offline/sync.ts ui/src/api/client.ts
git commit -m "feat(ui): offline full-text search over the cached vault"
```

---

### Task 8: Offline UX — indicator, read-only editor, route error

**Files:**
- Modify: `ui/src/components/SyncIndicator.tsx`, `ui/src/components/codex/DesktopCodexFrame.tsx`, `ui/src/editor/usePageEditor.ts`, `ui/src/components/codex/Folio.tsx`, `ui/src/components/RouteError.tsx`
- Test: `ui/src/components/SyncIndicator.test.tsx`, `ui/src/components/RouteError.test.tsx`, `ui/src/components/codex/Folio.offline.test.tsx`

**Interfaces:**
- Consumes: `useOnlineStatus` (Task 4), `useOfflineStore` (Task 5), `isOfflineUncached` (Task 2).
- Produces: `usePageEditor(...)` result gains `offline: boolean`; `readonly` is true while offline.

- [ ] **Step 1: Write the failing indicator test**

`ui/src/components/SyncIndicator.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOfflineStore } from "#/offline/offlineStore";

const useVaultEvents = vi.hoisted(() => vi.fn(() => "connected"));
const useOnlineStatus = vi.hoisted(() => vi.fn(() => true));
vi.mock("#/hooks/useVaultEvents", () => ({ useVaultEvents }));
vi.mock("#/hooks/useOnlineStatus", () => ({ useOnlineStatus }));

import { SyncIndicator } from "#/components/SyncIndicator";

beforeEach(() => {
  useVaultEvents.mockReturnValue("connected");
  useOnlineStatus.mockReturnValue(true);
  useOfflineStore.setState({ lastFullSync: "2026-09-12T14:02:00Z", pageCount: 252 });
});

describe("SyncIndicator", () => {
  it("shows Live when connected", () => {
    render(<SyncIndicator />);
    expect(screen.getByTitle("Live")).toBeInTheDocument();
  });

  it("shows the offline copy time when offline", () => {
    useOnlineStatus.mockReturnValue(false);
    useVaultEvents.mockReturnValue("disconnected");
    render(<SyncIndicator />);
    const expected = new Date("2026-09-12T14:02:00Z").toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(screen.getByTitle(`Offline — vault as of ${expected}`)).toBeInTheDocument();
  });

  it("says there is no copy when offline without one", () => {
    useOnlineStatus.mockReturnValue(false);
    useVaultEvents.mockReturnValue("disconnected");
    useOfflineStore.setState({ lastFullSync: null });
    render(<SyncIndicator />);
    expect(screen.getByTitle("Offline — no offline copy")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement the indicator**

`ui/src/components/SyncIndicator.tsx`:

```tsx
import { useOnlineStatus } from "#/hooks/useOnlineStatus";
import { type ConnectionStatus, useVaultEvents } from "#/hooks/useVaultEvents";
import { cn } from "#/lib/cn";
import { useOfflineStore } from "#/offline/offlineStore";

type IndicatorStatus = ConnectionStatus | "offline";

const STATUS_COLORS: Record<IndicatorStatus, string> = {
  connecting: "bg-muted-foreground",
  connected: "bg-foreground",
  disconnected: "bg-destructive",
  offline: "bg-muted-foreground",
};

export function offlineLabel(lastFullSync: string | null): string {
  if (!lastFullSync) return "Offline — no offline copy";
  const time = new Date(lastFullSync).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Offline — vault as of ${time}`;
}

function labelFor(status: IndicatorStatus, lastFullSync: string | null) {
  switch (status) {
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Live";
    case "disconnected":
      return "Disconnected";
    case "offline":
      return offlineLabel(lastFullSync);
  }
}

export function SyncIndicator() {
  const sse = useVaultEvents();
  const online = useOnlineStatus();
  const lastFullSync = useOfflineStore((s) => s.lastFullSync);
  const status: IndicatorStatus = online ? sse : "offline";
  const label = labelFor(status, lastFullSync);

  return (
    <div
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      title={label}
    >
      <div className={cn("h-1.5 w-1.5", STATUS_COLORS[status])} />
      <span className="sr-only">{label}</span>
    </div>
  );
}
```

In `ui/src/components/codex/DesktopCodexFrame.tsx` around line 65-81, where `syncStatus` drives a label, add `const online = useOnlineStatus();` and, wherever the "disconnected" wording is chosen, prefer `offlineLabel(lastFullSync)` when `!online` (import `offlineLabel` from `#/components/SyncIndicator` and `useOfflineStore`). Keep the change minimal: the frame shows "Offline — vault as of HH:MM" instead of its disconnected wording when offline.

- [ ] **Step 3: Run the indicator test**

Run: `cd ui && bun run test src/components/SyncIndicator.test.tsx src/components/codex`
Expected: PASS.

- [ ] **Step 4: Editor read-only while offline — failing test**

`ui/src/components/codex/Folio.offline.test.tsx` — model it on the nearest existing Folio test (`ls ui/src/components/codex/*Folio*.test.tsx`; copy its render harness: QueryClientProvider, router stub, page fixture mocks). The assertions that matter:

```tsx
// after rendering a Folio for a normal, non-readonly page fixture:
useOnlineStatus.mockReturnValue(false);   // via vi.mock("#/hooks/useOnlineStatus")
rerender(...);
expect(screen.getByRole("status")).toHaveTextContent("Offline — read only");
// the editable surface is read-only:
expect(document.querySelector('[contenteditable="false"]')).not.toBeNull();
expect(screen.queryByRole("button", { name: "Edit anyway" })).toBeNull();
```

If no Folio render harness exists that can mount without a live editor, test at the hook level instead: `ui/src/editor/usePageEditor.offline.test.tsx` rendering `usePageEditor("notes/a.md")` with `usePage` mocked to return a page fixture with `readonly: false`, asserting `result.current.readonly === false` online and `true` after `useOnlineStatus` returns false, and `result.current.offline === true`.

- [ ] **Step 5: Implement**

`ui/src/editor/usePageEditor.ts`:
- Import `useOnlineStatus` from `#/hooks/useOnlineStatus`.
- Inside the hook: `const online = useOnlineStatus();`
- In the returned object: `readonly: (page?.readonly ?? false) || !online,` and add `offline: !online,`.
- Add to the result interface (near `readonly: boolean;`): `/** True while the device is offline; the body is forced read-only. */ offline: boolean;`
- Before flipping to read-only, flush pending edits: add an effect
  ```ts
  useEffect(() => {
    if (!online) void doSave();
  }, [online, doSave]);
  ```
  placed after `doSave` is defined. `doSave` already no-ops when nothing is dirty; if it fails the existing `saveError` toast path reports it.

`ui/src/components/codex/Folio.tsx`:
- Change line 578 to
  ```ts
  const offlineReadOnly = editor.offline === true;
  const bodyProtected = editor.readonly === true && !offlineReadOnly;
  const folioReadOnly = conversationReadOnly || recipeReadOnly || bodyProtected || offlineReadOnly;
  ```
- Line 1166 becomes:
  ```tsx
  {offlineReadOnly ? (
    <OfflineBodyNotice />
  ) : bodyProtected ? (
    <ProtectedBodyNotice onUnlock={() => editor.setReadonly(false)} />
  ) : null}
  ```
- Every other `bodyProtected` use (lines ~914, ~1059, ~1204) must also pass read-only when `offlineReadOnly`: at 1204 use `readOnly={conversationReadOnly || bodyProtected || offlineReadOnly}`; at 914 and 1059 (archive-specific) leave as is.
- Add next to `ProtectedBodyNotice`:
  ```tsx
  function OfflineBodyNotice() {
    return (
      <div
        role="status"
        className="mb-4 flex items-center gap-3 border border-rule px-3 py-2 text-[13px] text-ink-2"
      >
        <span>Offline — read only. Edits resume when the connection returns.</span>
      </div>
    );
  }
  ```
  If the test asserts the exact text "Offline — read only", keep that phrase at the start of the sentence as written.

- [ ] **Step 6: RouteError offline branch — failing test**

`ui/src/components/RouteError.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RouteError } from "#/components/RouteError";

describe("RouteError offline branch", () => {
  it("explains an uncached page when offline", () => {
    const error = {
      status: 503,
      data: { code: "offline_uncached", url: "/api/vault/pages/x.md" },
    };
    render(<RouteError error={error} info={undefined} reset={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Not available offline" })).toBeInTheDocument();
    expect(screen.getByText("This page hasn't been synced to this device yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("falls through to the generic error otherwise", () => {
    render(<RouteError error={new Error("boom")} info={undefined} reset={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Implement the branch**

In `ui/src/components/RouteError.tsx`, import `isOfflineUncached` from `#/offline/swPolicy`, and at the top of `RouteError` after computing `response`:

```tsx
  if (response && response.status === 503 && isOfflineUncached(response.payload)) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-6">
        <section className="border border-border bg-background p-5 shadow-md">
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            Offline
          </p>
          <h1 className="mt-2 font-heading text-2xl font-bold">
            Not available offline
          </h1>
          <p className="mt-2 text-sm">
            This page hasn't been synced to this device yet.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onPress={reset}>
              Retry
            </Button>
          </div>
        </section>
      </div>
    );
  }
```

`getResponseDetails` already extracts `data` into `payload` for openapi-fetch style errors. openapi-react-query throws the parsed error body itself (not a wrapper) for non-2xx, so the thrown value may be `{ code: "offline_uncached", url }` with no `status`. Extend the guard: `if (isOfflineUncached(error) || (response && response.status === 503 && isOfflineUncached(response.payload)))`. Add a third test case with `error = { code: "offline_uncached", url: "…" }` expecting the same heading.

- [ ] **Step 8: Run tests**

Run: `cd ui && bun run test src/components/RouteError.test.tsx src/components/codex src/editor`
Expected: PASS.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
cd ui && bun run typecheck && bun run lint
git add ui/src/components/SyncIndicator.tsx ui/src/components/SyncIndicator.test.tsx ui/src/components/codex/DesktopCodexFrame.tsx ui/src/editor/usePageEditor.ts ui/src/components/codex/Folio.tsx ui/src/components/codex/Folio.offline.test.tsx ui/src/components/RouteError.tsx ui/src/components/RouteError.test.tsx
git commit -m "feat(ui): offline indicator, read-only editor offline, not-available-offline route error"
```
(If the hook-level test was written instead of the Folio test, stage `ui/src/editor/usePageEditor.offline.test.tsx`.)

---

### Task 9: Docs

**Files:**
- Modify: `ui/src/docs/content/getting-started.mdx`, `ui/src/docs/content/troubleshooting.mdx`

- [ ] **Step 1: Getting started section**

Insert before the `## Privacy` heading in `ui/src/docs/content/getting-started.mdx`:

```mdx
## Install on iPhone and read offline

Clepsydra is a Progressive Web App. Installed to the home screen it keeps
the whole vault readable without a connection.

1. Open the vault URL in Safari (for example the tailnet address).
2. Tap Share, then **Add to Home Screen**, then **Add**.
3. Launch Clepsydra from the home screen once while online. The status
   dot in the frame shows **Live**; Settings → Advanced → **Offline copy**
   reports the page count and last sync time.

Offline, pages, links, the tree, tags, journals, the board, and search all
work from the copy. The body is read-only with an **Offline — read only**
notice, and the status dot reads **Offline — vault as of HH:MM**. Pages
changed on the server while you were away are re-synced automatically when
the connection returns; **Sync now** in Settings forces a full pass.

Not kept offline: attachments and archived web snapshots, block search, and
any edit.
```

- [ ] **Step 2: Troubleshooting entry**

Append to `ui/src/docs/content/troubleshooting.mdx` a section:

```mdx
## "Not available offline"

The page was not in the offline copy when the connection dropped. Reconnect
and open Settings → Advanced → **Sync now**; the copy is rebuilt in the
background. If the copy never completes, the **Offline copy** card shows how
many requests failed on the last pass.
```

- [ ] **Step 3: Docs tests, commit**

Run: `cd ui && bun run test src/docs`
Expected: PASS (`mdx-smoke` and `search` tests cover new content).

```bash
git add ui/src/docs/content/getting-started.mdx ui/src/docs/content/troubleshooting.mdx
git commit -m "docs(ui): install on iPhone and offline reading"
```

---

### Task 10: Production smoke test (Playwright, offline emulation)

**Files:**
- Create: `ui/e2e/offline.smoke.md` (the manual runbook, checked in) — no automated test file; the run is driven through the Playwright MCP plugin or a local Playwright script in the scratchpad.

- [ ] **Step 1: Build and serve against a scratch vault**

```bash
cd ui && bun run build
cd .. && cargo build -p clep
SCRATCH=$(mktemp -d)/vault && mkdir -p "$SCRATCH/notes"
printf -- '---\ntitle: Alpha\n---\n\nAlpha talks about water clocks.\n' > "$SCRATCH/notes/alpha.md"
printf -- '---\ntitle: Beta\n---\n\nBeta links to [[Alpha]].\n' > "$SCRATCH/notes/beta.md"
CLEPSYDRA__VAULT__ROOT="$SCRATCH" CLEPSYDRA__SERVER__PORT=3999 CLEPSYDRA__SERVER__DEV_MODE=false ./target/debug/clep serve
```
Expected: server on `http://localhost:3999` (localhost is a secure context, so the SW registers).

- [ ] **Step 2: Header checks**

```bash
curl -sI http://localhost:3999/sw.js | grep -iE 'cache-control|content-type'
curl -sI http://localhost:3999/manifest.webmanifest | grep -iE 'cache-control|content-type'
curl -sI "http://localhost:3999/$(ls ui/dist/assets | head -1 | sed 's#^#assets/#')" | grep -i cache-control
curl -sI http://localhost:3999/ | grep -i content-security-policy
```
Expected: `no-cache` + `text/javascript`; `no-cache` + `application/manifest+json`; `immutable`; CSP contains `worker-src 'self'` and `manifest-src 'self'`.

- [ ] **Step 3: Browser run**

With the Playwright MCP tools (or a scratch script):
1. Navigate to `http://localhost:3999/`. Wait 5 s. Evaluate `navigator.serviceWorker.controller !== null` → true.
2. Evaluate `caches.keys()` → includes `clep-api-v1`. Evaluate `(await (await caches.open("clep-api-v1")).keys()).length` → ≥ 6 (two pages × 3 + derived set).
3. Set the browser context offline (`browser_evaluate` cannot; use the Playwright context `setOffline(true)` in a scratch script, or Chrome DevTools "Offline" via the claude-in-chrome tools).
4. Navigate to `/pages/notes/beta.md` (a page never opened in this session) → body renders "Beta links to", the banner "Offline — read only" is present, the status title starts with "Offline — vault as of".
5. Open search (⌘K or the search route) and type `water` → a result for Alpha.
6. Navigate to `/tasking` and `/agenda` → render from cache without the route error.
7. Navigate to `/pages/notes/missing.md` → "Not available offline".
8. Go online. Append a line to `$SCRATCH/notes/alpha.md` on disk. Wait 5 s. Evaluate the cached `/api/vault/pages/notes%2Falpha.md` body → contains the new line.

Record each step's outcome in `ui/e2e/offline.smoke.md` with the date.

- [ ] **Step 4: iOS device check (user-run)**

Document in the same file the steps for the user: open the tailnet URL in Safari, Add to Home Screen, launch, wait for the Offline copy card to show the page count, enable Airplane Mode, open an unvisited page, search, open the board. Mark as "pending user verification".

- [ ] **Step 5: Commit**

```bash
git add ui/e2e/offline.smoke.md
git commit -m "test(ui): offline PWA smoke runbook and results"
```

---

### Task 11: Verification gates and merge

- [ ] **Step 1: Full gates**

```bash
cd ui && bun run typecheck && bun run lint && bun run test && bun run knip
cd .. && cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```
Expected: all green. Report the exact counts.

- [ ] **Step 2: Format sweep**

```bash
cd ui && bun run format && git checkout -- src/routeTree.gen.ts src/api/schema.d.ts
git status --short
```
Commit any formatting-only changes: `git commit -am "style(ui): biome format"` (only if there are changes; stage explicit paths).

- [ ] **Step 3: Merge to develop**

```bash
git checkout develop && git pull --ff-only
git merge --no-ff feature/offline-pwa -m "feat: offline PWA (read-only, whole-vault sync, iOS install)"
git branch -d feature/offline-pwa
```

Update `docs/superpowers/specs/2026-09-12-offline-pwa-design.md` status line to "Merged to develop as <sha> (<date>)" and commit.

---

## Self-review

**Spec coverage**
- §3 app shell/install → Task 3 (plugin, manifest, icons, meta, registration), Task 9 (install docs).
- §4 SW policy → Task 2 (classification, 503), Task 3 (`sw.ts` routes, 4 s timeout, status 200 only, cache name).
- §5 walker (full pass, prune, delta, coalescing, triggers, guards, state) → Tasks 5 and 6. Note: `/api/vault/pages` takes no pagination params (`query?: never` in `schema.d.ts`), so the spec's "paginated list" collapses to one request; the plan reflects the real route.
- §6 search fallback → Task 7 (index, memo + invalidation on pass completion, response shape, encrypted skipped, `onError` path).
- §7 UX → Task 4 (online status, backoff, pause offline), Task 8 (indicator, editor read-only + flush, banner, route error).
- §8 server → Task 1.
- §9 testing → each task carries its tests; Task 10 is the production smoke.
- §10 non-goals → nothing in the plan adds offline writes, blob caching, or block search.

**Placeholder scan**: Task 8 Step 4 offers a hook-level alternative if no Folio harness exists; both variants are fully specified. Task 5 Step 2 asks the implementer to verify hook query shapes against source; the fallback rule (hook wins) is explicit.

**Type consistency**: `ConnectionStatus` re-exported from `useVaultEvents` so `SyncIndicator`'s existing import keeps working. `SyncDeps` shape identical in Tasks 5, 6. `invalidateOfflineIndex` is called from `sync.ts` (Task 7 fix-up) so the `search.ts → sync.ts` import is removed; `onSyncComplete` remains exported and tested in Task 5. `offlineLabel` exported from `SyncIndicator.tsx` for `DesktopCodexFrame`. `usePageEditor` result gains `offline: boolean`, consumed in `Folio.tsx`.
