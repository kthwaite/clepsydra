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
