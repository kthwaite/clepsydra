import type { QueryClient } from "@tanstack/react-query";
import type { operations } from "./schema";

export type BaseEvaluationQueryKey = readonly [
  "post",
  "/api/vault/bases/{slug}/views/{view}/evaluate",
  string,
];

export const queryKeys = {
  blocks: {
    all: ["blocks"] as const,
    detail: (blockId: string) => ["blocks", blockId] as const,
    search: (query: string, limit: number) =>
      ["blocks", "search", query, limit] as const,
  },

  tasks: {
    all: ["tasks"] as const,
    list: (params: object) => ["tasks", params] as const,
    history: (project?: string, unfiled = false) =>
      ["tasks", "history", project, unfiled] as const,
  },

  agenda: {
    all: ["agenda"] as const,
    byDate: (today: string) => ["agenda", today] as const,
    cycleBurndown: (cycle: string | null, project?: string, unfiled = false) =>
      ["agenda", "cycle-burndown", cycle, project, unfiled] as const,
  },

  journal: {
    all: ["journal"] as const,
    today: ["journal", "today"] as const,
    recent: (days: number) => ["journal", "recent", days] as const,
  },

  aiJournal: {
    all: ["ai-journal"] as const,
    today: ["ai-journal", "today"] as const,
    recent: (days: number) => ["ai-journal", "recent", days] as const,
  },

  board: {
    all: ["board"] as const,
  },

  bcl: {
    current: ["bcl"] as const,
  },

  location: {
    current: ["location"] as const,
  },

  encryption: { pathPrefix: "/api/vault/encryption" },
  attachments: { pathPrefix: "/api/vault/attachments" },
  academic: { pathPrefix: "/api/vault/academic" },

  feeds: { pathPrefix: "/api/vault/feeds" },
  rubbish: {
    all: ["get", "/api/vault/rubbish"] as const,
    pathPrefix: "/api/vault/rubbish",
  },

  pages: {
    pathPrefix: "/api/vault/pages",
    propertyProjectionPath: "/api/vault/pages/by-id/{uuid}/properties",
  },
  folders: { pathPrefix: "/api/vault/folders" },
  index: {
    pathPrefix: "/api/vault/index",
    issuesPath: "/api/vault/index/issues",
    graphPath: "/api/vault/index/graph",
    issues: (
      query: NonNullable<operations["reference_issues"]["parameters"]["query"]>,
    ) => ["get", "/api/vault/index/issues", { params: { query } }] as const,
  },
  bases: {
    pathPrefix: "/api/vault/bases",
    evaluation: (identity: string): BaseEvaluationQueryKey => [
      "post",
      "/api/vault/bases/{slug}/views/{view}/evaluate",
      identity,
    ],
  },
  query: { pathPrefix: "/api/vault/query" },

  sync: {
    prefix: ["sync"] as const,
    conflicts: () => [...queryKeys.sync.prefix, "conflicts"] as const,
    conflictsPath: "/api/vault/sync/conflicts" as const,
  },
} as const;

/** Invalidate all openapi-react-query queries whose path (queryKey[1]) starts with `prefix`. */
export function invalidateByPath(qc: QueryClient, prefix: string) {
  return qc.invalidateQueries({
    predicate: (query) => {
      const path = query.queryKey[1];
      return typeof path === "string" && path.startsWith(prefix);
    },
  });
}

/** Invalidate the Rubbish Bin list and every item-detail query. */
export function invalidateRubbish(qc: QueryClient) {
  const prefix = queryKeys.rubbish.pathPrefix;
  return qc.invalidateQueries({
    predicate: (query) => {
      const path = query.queryKey[1];
      return (
        typeof path === "string" &&
        (path === prefix || path.startsWith(`${prefix}/`))
      );
    },
  });
}

/** Pull the actual `path` param out of a `usePage` openapi-react-query key. */
function pageDetailKeyPath(queryKey: readonly unknown[]): string | undefined {
  const params = queryKey[2] as
    | { params?: { path?: { path?: string } } }
    | undefined;
  return params?.params?.path?.path;
}

/** Pull the UUID param out of a generated page-property projection key. */
function pagePropertyProjectionKeyUuid(
  queryKey: readonly unknown[],
): string | undefined {
  const params = queryKey[2] as
    | { params?: { path?: { uuid?: string } } }
    | undefined;
  return params?.params?.path?.uuid;
}

function invalidatePagePropertyProjection(
  qc: QueryClient,
  uuid?: string,
): void {
  if (!uuid) {
    invalidateByPath(qc, queryKeys.pages.propertyProjectionPath);
    return;
  }
  qc.invalidateQueries({
    predicate: (query) =>
      query.queryKey[1] === queryKeys.pages.propertyProjectionPath &&
      pagePropertyProjectionKeyUuid(query.queryKey) === uuid,
  });
}

/**
 * Invalidate every cache derived from a page body — both openapi-react-query
 * paths (pages, index) and the hand-rolled key trees (blocks, tasks, agenda,
 * journal). Use after any mutation that edits page content.
 *
 * Pass `path` (the edited page) to scope the page-body invalidation to just
 * that folio plus the page list, instead of marking *every* cached page body
 * stale. Pass `uuid` when the successful mutation identifies it so the
 * authoritative Base projection can be invalidated exactly; otherwise all
 * page-property projections are invalidated. The index tree and aggregate
 * views stay broad because their data spans the vault.
 */
export function invalidatePageContent(
  qc: QueryClient,
  path?: string,
  uuid?: string,
) {
  if (path) {
    const detailTemplate = `${queryKeys.pages.pathPrefix}/{path}`;
    qc.invalidateQueries({
      predicate: (query) => {
        const template = query.queryKey[1];
        if (template === queryKeys.pages.pathPrefix) return true; // the list
        if (template === detailTemplate)
          return pageDetailKeyPath(query.queryKey) === path;
        return false;
      },
    });
    invalidatePagePropertyProjection(qc, uuid);
  } else {
    invalidateByPath(qc, queryKeys.pages.pathPrefix);
  }
  invalidateByPath(qc, queryKeys.index.pathPrefix);
  qc.invalidateQueries({ queryKey: queryKeys.blocks.all });
  qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
  qc.invalidateQueries({ queryKey: queryKeys.agenda.all });
  qc.invalidateQueries({ queryKey: queryKeys.journal.all });
  qc.invalidateQueries({ queryKey: queryKeys.aiJournal.all });
}

/** Same as `invalidatePageContent` plus folder listings — for create/move/delete. */
export function invalidatePageStructure(qc: QueryClient) {
  invalidatePageContent(qc);
  invalidateByPath(qc, queryKeys.folders.pathPrefix);
}
