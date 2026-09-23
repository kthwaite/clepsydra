import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOfflineStore } from "#/offline/offlineStore";
import { API_CACHE_NAME } from "#/offline/swPolicy";
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

// openapi-fetch reads `globalThis.fetch` (and constructs requests with
// `globalThis.Request`) once, when `fetchClient` is created (module load of
// #/api/client.ts, pulled in transitively through walkSet.ts -> sync.ts
// above). A `vi.stubGlobal` called from inside a test body runs too late to
// affect those already-bound references, and Node's native Request rejects
// relative URLs outright, so both globals have to be replaced via
// `vi.hoisted` — hoisted above every import by vitest's transform — before
// `fetchClient` exists. Same pattern as src/api/feeds.test.ts. Each test then
// reconfigures behaviour with `fetchMock.mockReset()` +
// `fetchMock.mockImplementation(...)` instead of re-stubbing the global.
const { fetchMock } = vi.hoisted(() => {
  const NativeRequest = globalThis.Request;
  class BrowserLikeRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(
        typeof input === "string" ? new URL(input, "http://localhost") : input,
        init,
      );
    }
  }
  const fetchMock = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("Request", BrowserLikeRequest);
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock };
});

const PAGES = ["notes/a.md", "notes/b.md", "proj/c.md"];

function pathOf(input: RequestInfo | URL): string {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const u = new URL(url, "http://localhost");
  return u.pathname + u.search;
}

let calls: string[];
let inFlight: number;
let maxInFlight: number;
let release: Array<() => void>;

function installFetch(
  options: { hold?: boolean; failOn?: (path: string) => boolean } = {},
) {
  calls = [];
  inFlight = 0;
  maxInFlight = 0;
  release = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
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
  });
}

function deps(
  overrides: Partial<SyncDeps> = {},
): SyncDeps & { storage: FakeCacheStorage } {
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
    await cache.put(
      "http://localhost/api/vault/pages/gone.md",
      jsonResponse({}),
    );
    await cache.put(
      "http://localhost/api/vault/index/backlinks/gone.md",
      jsonResponse({}),
    );
    await cache.put(
      "http://localhost/api/vault/pages/notes%2Fa.md",
      jsonResponse({}),
    );
    await cache.put(
      "http://localhost/api/vault/journal/recent?days=7",
      jsonResponse({}),
    );
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
    await cache.put(
      "http://localhost/api/vault/pages/old.md",
      jsonResponse({}),
    );
    await cache.put(
      "http://localhost/api/vault/index/outlinks/old.md",
      jsonResponse({}),
    );
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
      expect.arrayContaining([
        "/api/vault/pages/notes%2Fa.md",
        "/api/vault/pages/notes%2Fb.md",
      ]),
    );
    expect(calls.filter((p) => p === "/api/vault/folders/tree")).toHaveLength(
      1,
    );
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

  it("lets a full request pre-empt a pending delta coalesce timer", async () => {
    vi.useFakeTimers();
    installFetch();
    const controller = new OfflineSyncController(deps());
    controller.requestDelta({ upserted: ["notes/a.md"], removed: [] });
    controller.requestFull();
    // The full request must not wait behind the delta's coalesce window.
    await vi.advanceTimersByTimeAsync(DELTA_COALESCE_MS - 1);
    expect(calls).toContain("/api/vault/pages");
    // No separate delta pass should follow — the full pass already
    // subsumed it, so exactly one list call total.
    await vi.runAllTimersAsync();
    expect(calls.filter((p) => p === "/api/vault/pages")).toHaveLength(1);
    controller.dispose();
  });
});
