import type { QueryClient } from "@tanstack/react-query";

export const queryKeys = {
  blocks: {
    all: ["blocks"] as const,
    detail: (blockId: string) => ["blocks", blockId] as const,
    search: (query: string, limit: number) =>
      ["blocks", "search", query, limit] as const,
  },

  tasks: {
    all: ["tasks"] as const,
    list: (params: Record<string, string>) => ["tasks", params] as const,
  },

  agenda: {
    all: ["agenda"] as const,
    today: ["agenda", "today"] as const,
    week: ["agenda", "week"] as const,
    overdue: ["agenda", "overdue"] as const,
  },

  journal: {
    all: ["journal"] as const,
    today: ["journal", "today"] as const,
    byDate: (date: string) => ["journal", date] as const,
    recent: (days: number) => ["journal", "recent", days] as const,
  },

  bcl: {
    current: ["bcl"] as const,
  },

  location: {
    current: ["location"] as const,
  },

  pages: { pathPrefix: "/api/vault/pages" },
  folders: { pathPrefix: "/api/vault/folders" },
  index: { pathPrefix: "/api/vault/index" },
} as const;

/** Invalidate all openapi-react-query queries whose path (queryKey[1]) starts with `prefix`. */
export function invalidateByPath(qc: QueryClient, prefix: string) {
  qc.invalidateQueries({
    predicate: (query) => {
      const path = query.queryKey[1];
      return typeof path === "string" && path.startsWith(prefix);
    },
  });
}

/**
 * Invalidate every cache derived from a page body — both openapi-react-query
 * paths (pages, index) and the hand-rolled key trees (blocks, tasks, agenda,
 * journal). Use after any mutation that edits page content.
 */
export function invalidatePageContent(qc: QueryClient) {
  invalidateByPath(qc, queryKeys.pages.pathPrefix);
  invalidateByPath(qc, queryKeys.index.pathPrefix);
  qc.invalidateQueries({ queryKey: queryKeys.blocks.all });
  qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
  qc.invalidateQueries({ queryKey: queryKeys.agenda.all });
  qc.invalidateQueries({ queryKey: queryKeys.journal.all });
}

/** Same as `invalidatePageContent` plus folder listings — for create/move/delete. */
export function invalidatePageStructure(qc: QueryClient) {
  invalidatePageContent(qc);
  invalidateByPath(qc, queryKeys.folders.pathPrefix);
}
