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
