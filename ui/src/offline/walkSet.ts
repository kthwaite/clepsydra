import { fetchClient } from "#/api/client";
import { localDateKey } from "#/lib/time";

export type WalkRequest = () => Promise<Response>;

export interface WalkItem {
  label: string;
  run: WalkRequest;
}

// routes/agenda.tsx calls useAgenda(localDateKey(new Date())) — the local
// calendar date, not the UTC date toISOString() would give near midnight.
function today(): string {
  return localDateKey(new Date());
}

/**
 * Derived views to keep warm. Each entry MUST send exactly the query string
 * its ui hook sends, otherwise the cache entry is never hit by navigation.
 * Cross-reference: journal.ts, aiJournal.ts, tasks.ts, AgendaTile.tsx, board.ts,
 * folders.ts, index.ts, bases.ts, features.ts, pages.ts.
 */
export const WALK_SET: ReadonlyArray<WalkItem> = [
  {
    label: "pages",
    run: () => fetchClient.GET("/api/vault/pages").then((r) => r.response),
  },
  {
    label: "folders/tree",
    run: () =>
      fetchClient.GET("/api/vault/folders/tree").then((r) => r.response),
  },
  {
    label: "index/tags",
    run: () => fetchClient.GET("/api/vault/index/tags").then((r) => r.response),
  },
  {
    label: "index/stats",
    run: () =>
      fetchClient.GET("/api/vault/index/stats").then((r) => r.response),
  },
  {
    label: "index/graph",
    run: () =>
      fetchClient.GET("/api/vault/index/graph").then((r) => r.response),
  },
  {
    label: "journal/today",
    run: () =>
      fetchClient.GET("/api/vault/journal/today").then((r) => r.response),
  },
  {
    label: "journal/recent",
    run: () =>
      fetchClient
        .GET("/api/vault/journal/recent", { params: { query: { days: 30 } } })
        .then((r) => r.response),
  },
  {
    label: "ai-journal/today",
    run: () =>
      fetchClient.GET("/api/vault/ai-journal/today").then((r) => r.response),
  },
  {
    label: "ai-journal/recent",
    run: () =>
      fetchClient
        .GET("/api/vault/ai-journal/recent", {
          params: { query: { days: 30 } },
        })
        .then((r) => r.response),
  },
  {
    label: "board",
    run: () => fetchClient.GET("/api/vault/board").then((r) => r.response),
  },
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
  {
    label: "bases",
    run: () => fetchClient.GET("/api/vault/bases").then((r) => r.response),
  },
  {
    label: "features",
    run: () => fetchClient.GET("/api/features").then((r) => r.response),
  },
];

export function pageRequests(path: string): WalkItem[] {
  const params = { params: { path: { path } } };
  return [
    {
      label: `page ${path}`,
      run: () =>
        fetchClient
          .GET("/api/vault/pages/{path}", params)
          .then((r) => r.response),
    },
    {
      label: `backlinks ${path}`,
      run: () =>
        fetchClient
          .GET("/api/vault/index/backlinks/{path}", params)
          .then((r) => r.response),
    },
    {
      label: `outlinks ${path}`,
      run: () =>
        fetchClient
          .GET("/api/vault/index/outlinks/{path}", params)
          .then((r) => r.response),
    },
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
