import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidatePageContent, queryKeys } from "./keys";

const API_BASE = "/api/vault/blocks";

export interface BlockResponse {
  block_id: string | null;
  content: string;
  block_type: string;
  properties: Record<string, string>;
  page_path: string;
  page_title: string | null;
  span_start: number;
  span_end: number;
}

export function useBlock(blockId: string) {
  return useQuery({
    queryKey: queryKeys.blocks.detail(blockId),
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/${blockId}`);
      if (!res.ok) throw new Error("Block not found");
      return res.json() as Promise<BlockResponse>;
    },
    enabled: !!blockId,
  });
}

export function useSearchBlocks(query: string, limit = 8) {
  return useQuery({
    queryKey: queryKeys.blocks.search(query, limit),
    queryFn: async () => {
      const res = await fetch(
        `${API_BASE}/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      );
      if (!res.ok) throw new Error("Search failed");
      return res.json() as Promise<BlockResponse[]>;
    },
    enabled: query.length >= 2,
  });
}

export function useAssignBlockId() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { page_path: string; span_start: number }) => {
      const res = await fetch(`${API_BASE}/assign-id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) throw new Error("Failed to assign block ID");
      return res.json() as Promise<{ block_id: string }>;
    },
    onSuccess: (_data, variables) =>
      invalidatePageContent(qc, variables.page_path),
  });
}
