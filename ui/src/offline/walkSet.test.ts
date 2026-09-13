import { afterEach, describe, expect, it, vi } from "vitest";
import { localDateKey } from "#/lib/time";
import { jsonResponse } from "#/offline/testing/fakeCaches";
import { pageCacheKeys, pageRequests, WALK_SET } from "#/offline/walkSet";

// openapi-fetch reads `globalThis.fetch` (and constructs requests with
// `globalThis.Request`) once, when `fetchClient` is created at module load
// of #/api/client.ts (pulled in transitively above). A `vi.stubGlobal`
// called from inside a test body runs too late to affect those already-bound
// references, and Node's native Request rejects relative URLs outright, so
// both globals have to be replaced via `vi.hoisted` — hoisted above every
// import by vitest's transform — before `fetchClient` exists. Same pattern
// as src/api/feeds.test.ts.
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

afterEach(() => {
  fetchMock.mockReset();
});

async function collectUrls(
  runs: ReadonlyArray<{ run: () => Promise<Response> }>,
) {
  const urls: string[] = [];
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    urls.push(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    return jsonResponse({});
  });
  for (const item of runs) await item.run();
  return urls.map(
    (u) =>
      new URL(u, "http://localhost").pathname +
      new URL(u, "http://localhost").search,
  );
}

describe("WALK_SET", () => {
  it("mirrors the exact query strings the ui hooks send", async () => {
    // routes/agenda.tsx calls useAgenda(localDateKey(new Date())) — local
    // calendar date, not the UTC date toISOString() would give.
    const today = localDateKey(new Date());
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
