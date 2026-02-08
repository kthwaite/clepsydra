import { useQueryClient } from "@tanstack/react-query";
import { $api, invalidateByPathPrefix } from "./client";

export function usePages() {
  return $api.useQuery("get", "/api/vault/pages");
}

export function usePage(path: string) {
  return $api.useQuery(
    "get",
    "/api/vault/pages/{path}",
    { params: { path: { path } } },
    { enabled: !!path },
  );
}

export function useFolderTreePaths() {
  const query = $api.useQuery("get", "/api/vault/folders/tree");
  return { ...query, data: query.data?.paths };
}

export function useCreatePage() {
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/vault/pages/{path}", {
    onSuccess: () => {
      invalidateByPathPrefix(qc, "/api/vault/pages");
      invalidateByPathPrefix(qc, "/api/vault/folders");
      invalidateByPathPrefix(qc, "/api/vault/index");
    },
  });
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/vault/folders/{path}", {
    onSuccess: () => {
      invalidateByPathPrefix(qc, "/api/vault/pages");
      invalidateByPathPrefix(qc, "/api/vault/folders");
    },
  });
}
