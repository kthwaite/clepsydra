import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "#/api/schema";
import { fetchClient } from "./client";
import { invalidatePageContent, queryKeys } from "./keys";

export type BlockResponse = components["schemas"]["BlockResponse"];

function apiError(error: components["schemas"]["ApiError"], fallback: string) {
  return new Error(error.error || fallback);
}

export class BlockApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "BlockApiError";
    this.status = status;
  }
}

export function isBlockNotFound(error: unknown): error is BlockApiError {
  return error instanceof BlockApiError && error.status === 404;
}

/**
 * Fail closed for block details derived from changed pages.
 *
 * Resetting synchronously drops retained plaintext and cancels both matching
 * refetches and unseeded detail fetches before an obsolete response can restore
 * or first populate that data. Search queries remain separate and are
 * invalidated by the caller's normal block-prefix invalidation.
 */
export function clearBlockDetailsForPagePaths(
  queryClient: QueryClient,
  paths: readonly string[],
) {
  const changedPaths = new Set(paths);
  const clearAll = changedPaths.has("*");
  return queryClient.resetQueries(
    {
      queryKey: queryKeys.blocks.all,
      predicate: (query) => {
        const isBlockDetail =
          query.queryKey.length === 2 &&
          query.queryKey[0] === queryKeys.blocks.all[0] &&
          typeof query.queryKey[1] === "string";
        if (!isBlockDetail) return false;

        const data = query.state.data;
        if (data == null) {
          return query.state.fetchStatus === "fetching";
        }
        if (Array.isArray(data) || typeof data !== "object") return false;
        if (!("page_path" in data) || typeof data.page_path !== "string") {
          return false;
        }
        return clearAll || changedPaths.has(data.page_path);
      },
    },
    { cancelRefetch: true },
  );
}

export function useBlock(blockId: string) {
  return useQuery({
    queryKey: queryKeys.blocks.detail(blockId),
    queryFn: async () => {
      const { data, error, response } = await fetchClient.GET(
        "/api/vault/blocks/{block_id}",
        { params: { path: { block_id: blockId } } },
      );
      if (error) {
        throw new BlockApiError(
          error.error || "Block not found",
          response.status,
        );
      }
      if (!data) throw new Error("Block response was empty");
      return data;
    },
    throwOnError: false,
    retry: (failureCount, error) => !isBlockNotFound(error) && failureCount < 3,
    enabled: !!blockId,
  });
}

export function useSearchBlocks(query: string, limit = 8) {
  return useQuery({
    queryKey: queryKeys.blocks.search(query, limit),
    queryFn: async () => {
      const { data, error } = await fetchClient.GET(
        "/api/vault/blocks/search",
        { params: { query: { q: query, limit } } },
      );
      if (error) throw apiError(error, "Search failed");
      return data ?? [];
    },
    enabled: query.length >= 2,
  });
}

export function useAssignBlockId() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { page_path: string; span_start: number }) => {
      const { data, error } = await fetchClient.POST(
        "/api/vault/blocks/assign-id",
        { body: params },
      );
      if (error) throw apiError(error, "Failed to assign block ID");
      if (!data) throw new Error("Block ID response was empty");
      return data;
    },
    onSuccess: (_data, variables) =>
      invalidatePageContent(qc, variables.page_path),
  });
}
