import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "#/api/schema";
import { fetchClient } from "./client";
import { invalidatePageContent, queryKeys } from "./keys";

export type BlockResponse = components["schemas"]["BlockResponse"];

function apiError(error: components["schemas"]["ApiError"], fallback: string) {
  return new Error(error.error || fallback);
}

export function useBlock(blockId: string) {
  return useQuery({
    queryKey: queryKeys.blocks.detail(blockId),
    queryFn: async () => {
      const { data, error } = await fetchClient.GET(
        "/api/vault/blocks/{block_id}",
        { params: { path: { block_id: blockId } } },
      );
      if (error) throw apiError(error, "Block not found");
      if (!data) throw new Error("Block response was empty");
      return data;
    },
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
