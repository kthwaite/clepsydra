import { useQueryClient } from "@tanstack/react-query";
import { $api } from "./client";
import { invalidatePageStructure } from "./keys";

export function useFolderTreePaths() {
  const query = $api.useQuery("get", "/api/vault/folders/tree");
  return { ...query, data: query.data?.paths };
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/vault/folders/{path}", {
    onSuccess: () => invalidatePageStructure(qc),
  });
}

export function useMoveFolder() {
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/vault/folders-move/{path}", {
    onSuccess: () => invalidatePageStructure(qc),
  });
}

export function useDeleteFolder() {
  const qc = useQueryClient();
  return $api.useMutation("delete", "/api/vault/folders/{path}", {
    onSuccess: () => invalidatePageStructure(qc),
  });
}
