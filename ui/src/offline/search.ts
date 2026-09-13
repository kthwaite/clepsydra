import MiniSearch from "minisearch";
import type { Middleware } from "openapi-fetch";
import type { components } from "#/api/schema";
import { API_CACHE_NAME, isOfflineUncached } from "#/offline/swPolicy";

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
