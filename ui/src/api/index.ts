import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { components, operations } from "#/api/schema";
import { $api, fetchClient } from "./client";
import { invalidateByPath, invalidatePageStructure, queryKeys } from "./keys";

export type AmbiguousName = components["schemas"]["AmbiguousName"];
export type CreateFromLinkRequest =
  components["schemas"]["CreateFromLinkRequest"];
export type RebuildResponse = components["schemas"]["RebuildResponse"];
export type UnresolvedLink = components["schemas"]["UnresolvedLink"];
export type ReferenceIssue = components["schemas"]["ReferenceIssueDto"];
export type ReferenceIssuesResponse =
  components["schemas"]["ReferenceIssuesResponse"];
export type ReferenceRepairPreview =
  components["schemas"]["ReferenceRepairPreviewResponse"];
export type ReferenceRepairRequest =
  components["schemas"]["ReferenceRepairRequest"];
export type ReferenceRepairResult =
  components["schemas"]["ReferenceRepairApplyResponse"];

export interface ReferenceIssueFilters {
  kind?: ReferenceIssue["kind"][];
  project?: string;
  pageKind?: string;
  actionable?: boolean;
  limit?: number;
  offset?: number;
}

export type MutationOperation = "move_page" | "delete_page" | "move_folder";
export type MutationRewrite = "plain_text" | "unlink" | "none";

export interface MutationPreviewRequest {
  operation: MutationOperation;
  source: string;
  destination?: string;
  rewrite?: MutationRewrite;
}

export interface PlannedFileOperation {
  kind: "rename" | "delete" | "create_dir";
  path: string;
  destination?: string;
}

export interface PlannedTextEdit {
  path: string;
  old_text: string;
  new_text: string;
}

export interface MutationPreview {
  file_ops: PlannedFileOperation[];
  text_edits: PlannedTextEdit[];
}

function parseMutationPreview(value: unknown): MutationPreview {
  if (typeof value !== "object" || value === null) {
    throw new Error("Mutation preview returned an invalid response.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    !Array.isArray(candidate.file_ops) ||
    !candidate.file_ops.every(
      (operation) =>
        typeof operation === "object" &&
        operation !== null &&
        "kind" in operation &&
        (operation.kind === "rename" ||
          operation.kind === "delete" ||
          operation.kind === "create_dir") &&
        "path" in operation &&
        typeof operation.path === "string" &&
        (!("destination" in operation) ||
          operation.destination === null ||
          typeof operation.destination === "string"),
    ) ||
    !Array.isArray(candidate.text_edits) ||
    !candidate.text_edits.every(
      (edit) =>
        typeof edit === "object" &&
        edit !== null &&
        "path" in edit &&
        typeof edit.path === "string" &&
        "old_text" in edit &&
        typeof edit.old_text === "string" &&
        "new_text" in edit &&
        typeof edit.new_text === "string",
    )
  ) {
    throw new Error("Mutation preview returned an invalid response.");
  }
  return value as MutationPreview;
}

export function usePreviewMutation() {
  return useMutation<MutationPreview, Error, MutationPreviewRequest>({
    mutationFn: async (body) => {
      const { data, error } = await fetchClient.POST(
        "/api/vault/index/preview-mutation",
        { body },
      );
      if (error) throw error;
      return parseMutationPreview(data);
    },
  });
}

export function useBacklinks(path: string) {
  return $api.useQuery(
    "get",
    "/api/vault/index/backlinks/{path}",
    { params: { path: { path } } },
    { enabled: !!path },
  );
}

export function useUnresolvedLinks() {
  return $api.useQuery(
    "get",
    "/api/vault/index/unresolved",
    {},
    { throwOnError: false },
  );
}

export function useAmbiguousNames() {
  return $api.useQuery(
    "get",
    "/api/vault/index/ambiguous",
    {},
    { throwOnError: false },
  );
}

export function useIndexWarnings() {
  return $api.useQuery(
    "get",
    "/api/vault/index/warnings",
    {},
    { throwOnError: false },
  );
}
type ReferenceIssueQuery = NonNullable<
  operations["reference_issues"]["parameters"]["query"]
>;

function referenceIssueQuery(
  filters: ReferenceIssueFilters,
): ReferenceIssueQuery {
  const query: ReferenceIssueQuery = {};
  if (filters.kind?.length) query.kind = filters.kind;
  if (filters.project) query.project = filters.project;
  if (filters.pageKind) {
    query.page_kind = filters.pageKind as ReferenceIssueQuery["page_kind"];
  }
  if (filters.actionable !== undefined) query.actionable = filters.actionable;
  if (filters.limit !== undefined) query.limit = filters.limit;
  if (filters.offset !== undefined) query.offset = filters.offset;
  return query;
}

function referenceRepairError(
  error: components["schemas"]["ApiError"],
  fallback: string,
): Error {
  return new Error(error.error || fallback);
}

export function useReferenceIssues(
  filters: ReferenceIssueFilters,
): UseQueryResult<ReferenceIssuesResponse> {
  const query = referenceIssueQuery(filters);
  return useQuery({
    queryKey: queryKeys.index.issues(query),
    queryFn: async () => {
      const { data, error } = await fetchClient.GET(
        queryKeys.index.issuesPath,
        { params: { query } },
      );
      if (error) {
        throw referenceRepairError(
          error,
          "Failed to load reference issues.",
        );
      }
      if (!data) throw new Error("Reference issue response was empty.");
      return data;
    },
  });
}

export function usePreviewReferenceRepair(): UseMutationResult<
  ReferenceRepairPreview,
  Error,
  ReferenceRepairRequest
> {
  return useMutation({
    mutationFn: async (body) => {
      const { data, error } = await fetchClient.POST(
        "/api/vault/index/issues/preview",
        { body },
      );
      if (error) {
        throw referenceRepairError(
          error,
          "Failed to preview reference repair.",
        );
      }
      if (!data) throw new Error("Reference repair preview was empty.");
      return data;
    },
  });
}

function invalidateReferenceRepairQueries(queryClient: QueryClient): void {
  invalidateByPath(queryClient, queryKeys.index.issuesPath);
  invalidateByPath(queryClient, queryKeys.pages.pathPrefix);
  invalidateByPath(queryClient, queryKeys.index.graphPath);
  invalidateByPath(queryClient, queryKeys.query.pathPrefix);
  invalidateByPath(queryClient, queryKeys.bases.pathPrefix);
}

export function useApplyReferenceRepair(): UseMutationResult<
  ReferenceRepairResult,
  Error,
  ReferenceRepairRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body) => {
      const { data, error } = await fetchClient.POST(
        "/api/vault/index/issues/apply",
        { body },
      );
      if (error) {
        throw referenceRepairError(error, "Failed to apply reference repair.");
      }
      if (!data) throw new Error("Reference repair result was empty.");
      return data;
    },
    onSuccess: () => invalidateReferenceRepairQueries(queryClient),
  });
}

function useIndexInvalidation(includeAcademic = false) {
  const queryClient = useQueryClient();
  return () => {
    invalidatePageStructure(queryClient);
    if (includeAcademic) {
      invalidateByPath(queryClient, queryKeys.academic.pathPrefix);
    }
  };
}

export function useCreateFromLink() {
  const invalidate = useIndexInvalidation();
  return $api.useMutation("post", "/api/vault/index/create-from-link", {
    onSuccess: invalidate,
  });
}

export function useRebuildIndex() {
  const invalidate = useIndexInvalidation(true);
  return $api.useMutation("post", "/api/vault/index/rebuild", {
    onSuccess: invalidate,
  });
}

export function useTags(enabled = true) {
  return $api.useQuery("get", "/api/vault/index/tags", {}, { enabled });
}

export function useStats() {
  return $api.useQuery("get", "/api/vault/index/stats");
}

export function useGraph() {
  return $api.useQuery("get", "/api/vault/index/graph");
}

export function useSearch(query: string, limit?: number) {
  return $api.useQuery(
    "get",
    "/api/vault/index/search",
    { params: { query: { q: query, limit } } },
    { enabled: query.length > 0 },
  );
}

export function useContentIndex(limit?: number, offset?: number) {
  return $api.useQuery("get", "/api/vault/index/content-index", {
    params: { query: { limit, offset } },
  });
}

export { useOutlinks } from "./outlinks";
export { useSimilar } from "./similar";
