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
