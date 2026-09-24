import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { components } from "#/api/schema";
import { fetchClient } from "./client";
import { invalidatePageStructure, invalidateRubbish, queryKeys } from "./keys";

export type ConflictCompare = components["schemas"]["ConflictCompareDto"];
export type ConflictResolveRequest =
  components["schemas"]["ConflictResolveRequest"];
export type ConflictResolveResult = components["schemas"]["ConflictResolveDto"];

/**
 * An error from the conflict compare/resolve endpoints. `message` is the
 * server's message verbatim; `code` is `detail.code` when the server sent one
 * (`revision_conflict`, `resolve_by_hand`).
 */
export class SyncConflictApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(payload: components["schemas"]["ApiError"], status: number) {
    super(payload.error || `request failed with status ${status}`);
    this.name = "SyncConflictApiError";
    this.status = status;
    const detail = payload.detail;
    this.code =
      typeof detail === "object" &&
      detail !== null &&
      "code" in detail &&
      typeof detail.code === "string"
        ? detail.code
        : undefined;
  }
}

export function useConflictCompare(
  copy: string,
): UseQueryResult<ConflictCompare, SyncConflictApiError> {
  return useQuery({
    queryKey: queryKeys.sync.compare(copy),
    queryFn: async () => {
      const { data, error, response } = await fetchClient.GET(
        queryKeys.sync.comparePath,
        { params: { query: { copy } } },
      );
      if (error) throw new SyncConflictApiError(error, response.status);
      if (!data) throw new Error("Conflict compare response was empty.");
      return data;
    },
    // The revisions guard the resolve; a background refetch would silently
    // swap them under the operator's choices.
    refetchOnWindowFocus: false,
    retry: false,
    throwOnError: false,
  });
}

export function useResolveConflict(): UseMutationResult<
  ConflictResolveResult,
  SyncConflictApiError,
  ConflictResolveRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body) => {
      const { data, error, response } = await fetchClient.POST(
        queryKeys.sync.resolvePath,
        { body },
      );
      if (error) throw new SyncConflictApiError(error, response.status);
      if (!data) throw new Error("Conflict resolve response was empty.");
      return data;
    },
    // A 500 can follow a successful write of the original, so refresh on
    // every outcome rather than only on success. Page structure covers the
    // original's content and the copy leaving the page list.
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.sync.conflicts(),
      });
      invalidatePageStructure(queryClient);
      void invalidateRubbish(queryClient);
    },
  });
}
