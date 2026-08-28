import {
  type QueryClient,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import type { components } from "#/api/schema";
import {
  type BaseEmbedConfig,
  baseViewEvaluationBody,
  type EmbedScrollCap,
  embedScrollCap,
  nextWindowSize,
  queryIdentity,
} from "#/components/bases/embed-query";
import { $api, fetchClient } from "./client";
import { isApiError } from "./error";
import {
  type BaseEvaluationQueryKey,
  invalidateByPath,
  queryKeys,
} from "./keys";

export type ApiError = components["schemas"]["ApiError"];
export type BaseDetailResponse = components["schemas"]["BaseDetailResponse"];
export type BaseMemberCreateRequest =
  components["schemas"]["BaseMemberCreateRequest"];
export type BaseMemberCreateResponse =
  components["schemas"]["BaseMemberCreateResponse"];
export type BaseMemberCapability =
  components["schemas"]["BaseMemberCapability"];
export type BaseMemberDiagnostic =
  components["schemas"]["BaseMemberDiagnostic"];
export type BaseMemberImplication =
  components["schemas"]["BaseMemberImplication"];
export type BaseViewEvaluateRequest =
  components["schemas"]["BaseViewEvaluateRequest"];
export type BaseViewEvaluateResponse =
  components["schemas"]["BaseViewEvaluateResponse"];
export type BaseFile = components["schemas"]["BaseFilePayload"];
export type BasePropertyEntry = components["schemas"]["BasePropertyEntry"];
export type BaseListResponse = components["schemas"]["BaseListResponse"];
export type BaseSummary = components["schemas"]["BaseSummary"];
export type BaseMutationResponse =
  components["schemas"]["BaseMutationResponse"];
export type PageBaseIdentity = components["schemas"]["PageBaseIdentity"];
export type PageBasePropertiesResponse =
  components["schemas"]["PageBasePropertiesResponse"];
export type PageBaseProperty = components["schemas"]["PageBaseProperty"];
export type PagePreviewField = components["schemas"]["PagePreviewField"];
export type PagePreviewProjection =
  components["schemas"]["PagePreviewProjection"];
export type PagePropertyBlocker = components["schemas"]["PagePropertyBlocker"];
export type PagePropertyCompatibility =
  components["schemas"]["PagePropertyCompatibility"];
export type PagePropertyDeclaration =
  components["schemas"]["PagePropertyDeclaration"];
export type PropertyPatchResponse =
  components["schemas"]["PropertyPatchResponse"];
export type CreateBaseRequest = components["schemas"]["CreateBaseRequest"];
export type BasePreviewResponse = components["schemas"]["BasePreviewResponse"];
export type BaseFilter = components["schemas"]["Filter"];
export type FilterOp = components["schemas"]["Op"];
export type SortKey = components["schemas"]["SortKey"];
export type Aggregate = components["schemas"]["Aggregate"];
export type PropertyType = components["schemas"]["PropertyType"];
export type PropertyDefinition = components["schemas"]["PropertyDefinition"];
export type QueryOutput = components["schemas"]["QueryOutput"];
export type QueryRow = components["schemas"]["QueryRow"];
export type GroupResult = components["schemas"]["GroupResult"];
export type BaseViewDefinition = components["schemas"]["ViewDefinition"];
export type BaseFilePayload = components["schemas"]["BaseFilePayload"];

const BASE_MEMBER_SCOPES: ReadonlySet<string> = new Set([
  "membership",
  "view",
  "field",
  "embed",
]);

function isBaseMemberDiagnostic(value: unknown): value is BaseMemberDiagnostic {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (
    !("scope" in value) ||
    typeof value.scope !== "string" ||
    !BASE_MEMBER_SCOPES.has(value.scope) ||
    !("message" in value) ||
    typeof value.message !== "string"
  ) {
    return false;
  }
  if (
    "field" in value &&
    value.field !== null &&
    typeof value.field !== "string"
  ) {
    return false;
  }
  return (
    !("filter_path" in value) ||
    value.filter_path === null ||
    typeof value.filter_path === "string"
  );
}

export function decodeBaseMemberDiagnostics(
  error: unknown,
): BaseMemberDiagnostic[] {
  if (
    !isApiError(error) ||
    typeof error.detail !== "object" ||
    !error.detail ||
    !("diagnostics" in error.detail)
  ) {
    return [];
  }
  const diagnostics = error.detail.diagnostics;
  if (
    !Array.isArray(diagnostics) ||
    !diagnostics.every(isBaseMemberDiagnostic)
  ) {
    return [];
  }
  return diagnostics;
}

export function invalidateBaseMutationQueries(queryClient: QueryClient): void {
  invalidateByPath(queryClient, queryKeys.bases.pathPrefix);
  invalidateByPath(queryClient, queryKeys.query.pathPrefix);
  invalidateByPath(queryClient, queryKeys.pages.pathPrefix);
}

function invalidatePropertyCommitFailureQueries(
  queryClient: QueryClient,
): void {
  invalidateByPath(queryClient, queryKeys.bases.pathPrefix);
  invalidateByPath(queryClient, queryKeys.query.pathPrefix);
  queryClient.invalidateQueries({
    predicate: (query) => {
      const path = query.queryKey[1];
      return (
        typeof path === "string" &&
        path.startsWith(queryKeys.pages.pathPrefix) &&
        path !== queryKeys.pages.propertyProjectionPath
      );
    },
  });
}

function useInvalidateBaseQueries() {
  const queryClient = useQueryClient();
  return useCallback(
    () => invalidateBaseMutationQueries(queryClient),
    [queryClient],
  );
}

export const useBases = () => $api.useQuery("get", "/api/vault/bases", {});

export function useCreateBase() {
  const onSuccess = useInvalidateBaseQueries();
  return $api.useMutation("post", "/api/vault/bases", { onSuccess });
}

export function useCreateBaseMember() {
  const queryClient = useQueryClient();
  return $api.useMutation("post", "/api/vault/bases/{slug}/members", {
    onSuccess: () => invalidateBaseMutationQueries(queryClient),
  });
}

export function useUpdateBase() {
  const onSuccess = useInvalidateBaseQueries();
  return $api.useMutation("put", "/api/vault/bases/{slug}", { onSuccess });
}

export function useDeleteBase() {
  const onSuccess = useInvalidateBaseQueries();
  return $api.useMutation("delete", "/api/vault/bases/{slug}", { onSuccess });
}

export const usePreviewBase = () =>
  $api.useMutation("post", "/api/vault/bases/preview");

export function useBase(slug: string) {
  return $api.useQuery(
    "get",
    "/api/vault/bases/{slug}",
    { params: { path: { slug } } },
    { enabled: !!slug, throwOnError: false },
  );
}

export function usePageBaseProperties(uuid: string) {
  return $api.useQuery(
    "get",
    "/api/vault/pages/by-id/{uuid}/properties",
    { params: { path: { uuid } } },
    {
      enabled: !!uuid,
      retry: 2,
      throwOnError: false,
    },
  );
}

export interface ViewOverrides {
  sort?: string;
  dir?: "asc" | "desc";
}

export function useBaseView(
  slug: string,
  view: string | undefined,
  overrides: ViewOverrides = {},
) {
  return $api.useQuery(
    "get",
    "/api/vault/bases/{slug}/views/{view}",
    {
      params: {
        path: { slug, view: view ?? "" },
        query: {
          sort: overrides.sort,
          dir: overrides.dir,
        },
      },
    },
    { enabled: !!slug && !!view, throwOnError: false },
  );
}

async function evaluateWindow(
  config: BaseEmbedConfig,
  window: { limit: number; offset: number },
  signal: AbortSignal | undefined,
): Promise<BaseViewEvaluateResponse> {
  const { data, error } = await fetchClient.POST(
    "/api/vault/bases/{slug}/views/{view}/evaluate",
    {
      params: { path: { slug: config.base, view: config.view } },
      body: baseViewEvaluationBody(config, window),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  if (error) throw error;
  if (!data) {
    throw {
      status: 500,
      error: "Embedded Base evaluation response was empty",
      hint: null,
    } satisfies ApiError;
  }
  return data;
}

function rowsIn(output: QueryOutput): number {
  return output.shape === "flat"
    ? output.rows.length
    : output.groups.reduce((sum, group) => sum + group.rows.length, 0);
}

function totalIn(output: QueryOutput): number {
  return output.shape === "flat"
    ? output.total
    : output.groups.reduce((sum, group) => sum + group.total, 0);
}

/** One response out of the windows loaded so far.
 *
 * Rows are deduplicated by id: a page inserted above the window while the
 * reader scrolls slides a row into the next window, and a grid cannot render
 * the same row twice. The freshest window owns the total and the revision. */
function mergeWindows(
  pages: BaseViewEvaluateResponse[],
): BaseViewEvaluateResponse | undefined {
  const newest = pages.at(-1);
  if (!newest) return undefined;
  if (newest.output.shape !== "flat") return pages[0];

  const seen = new Set<string>();
  const rows: QueryRow[] = [];
  for (const page of pages) {
    if (page.output.shape !== "flat") continue;
    for (const row of page.output.rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  return {
    ...newest,
    output: {
      shape: "flat",
      rows,
      total: newest.output.total,
      aggregates: newest.output.aggregates,
    },
  };
}

export interface BaseViewWindows {
  data: BaseViewEvaluateResponse | undefined;
  error: ApiError | null;
  isLoading: boolean;
  isFetching: boolean;
  refetch(): Promise<{
    data: BaseViewEvaluateResponse | undefined;
    error: ApiError | null;
  }>;
  /** The authoritative row count behind the windows, not the rows rendered. */
  total: number | undefined;
  loaded: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  /** Which bound ended the scroll short of the total, if either did. */
  cappedBy: EmbedScrollCap | undefined;
  loadMore(): void;
}

/** An embedded view, loaded one window at a time.
 *
 * An embed is never uncapped: it asks for a window, and asks again as the
 * reader approaches the end of what it has. A grouped view is served whole
 * within its per-group windows and never pages — one flat offset has no
 * meaning across groups. */
export function useBaseViewWindows(config: BaseEmbedConfig): BaseViewWindows {
  const cap = config.limit;
  const query = useInfiniteQuery<
    BaseViewEvaluateResponse,
    ApiError,
    { pages: BaseViewEvaluateResponse[] },
    BaseEvaluationQueryKey,
    number
  >({
    queryKey: queryKeys.bases.evaluation(queryIdentity(config)),
    enabled: !!config.base && !!config.view,
    throwOnError: false,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      evaluateWindow(
        config,
        {
          limit: Math.max(1, nextWindowSize(cap, pageParam)),
          offset: pageParam,
        },
        signal,
      ),
    getNextPageParam: (last, pages) => {
      if (last.output.shape !== "flat") return undefined;
      const loaded = pages.reduce((sum, page) => sum + rowsIn(page.output), 0);
      if (loaded >= last.output.total) return undefined;
      if (nextWindowSize(cap, loaded) === 0) return undefined;
      return loaded;
    },
  });

  const pages = query.data?.pages;
  const merged = useMemo(
    () => (pages ? mergeWindows(pages) : undefined),
    [pages],
  );
  const refetch = useCallback(async () => {
    const result = await query.refetch();
    return {
      data: result.data ? mergeWindows(result.data.pages) : undefined,
      error: (result.error ?? null) as ApiError | null,
    };
  }, [query.refetch]);
  const { fetchNextPage } = query;
  const loadMore = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);

  const loaded = merged ? rowsIn(merged.output) : 0;
  const total = merged ? totalIn(merged.output) : undefined;
  return {
    data: merged,
    error: query.error,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    refetch,
    total,
    loaded,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    cappedBy:
      !query.hasNextPage && total !== undefined && loaded < total
        ? embedScrollCap(cap, loaded)
        : undefined,
    loadMore,
  };
}

/**
 * The property patch: the cell-edit write path. Sends only the changed keys
 * plus type hints from the base schema; the response embeds the refreshed
 * projections (read-after-write) so callers reconcile without waiting on SSE.
 */
function usePatchProperties() {
  const queryClient = useQueryClient();
  return $api.useMutation("patch", "/api/vault/pages/by-id/{uuid}/properties", {
    onSuccess: () => invalidateBaseMutationQueries(queryClient),
  });
}

/**
 * Revision-guarded single-key commit. Folio projections supply their
 * authoritative revision; legacy row consumers fall back to the page detail
 * revision. Failures still toast and refresh shared caches, but now reject so
 * controlled editors can retain their draft.
 */
export function usePropertyCommit() {
  const qc = useQueryClient();
  const patch = usePatchProperties();

  return useCallback(
    async (
      page: { id: string; path: string },
      key: string,
      value: unknown,
      hint?: PropertyType,
      expectedRevision?: string,
    ) => {
      try {
        let revision = expectedRevision;
        if (!revision) {
          // The generated client's path-parameter encoding matches the page
          // routes exactly (a raw template literal would break on # or %).
          const pageRes = await fetchClient.GET("/api/vault/pages/{path}", {
            params: { path: { path: page.path } },
          });
          revision = pageRes.data?.revision;
        }
        if (!revision) throw new Error("page revision fetch failed");

        return await patch.mutateAsync({
          params: { path: { uuid: page.id } },
          body: {
            set: value === null ? {} : { [key]: value },
            clear: value === null ? [key] : [],
            types: hint ? { [key]: hint } : {},
            expected_revision: revision,
          },
        });
      } catch (error) {
        toast.error(`Could not update ${key} — refreshed to current state`);
        invalidatePropertyCommitFailureQueries(qc);
        throw error;
      }
    },
    [patch, qc],
  );
}
