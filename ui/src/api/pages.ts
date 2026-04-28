import { useQueryClient } from "@tanstack/react-query";
import { $api } from "./client";
import { invalidateByPath, queryKeys } from "./keys";

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
      invalidateByPath(qc, queryKeys.pages.pathPrefix);
      invalidateByPath(qc, queryKeys.folders.pathPrefix);
      invalidateByPath(qc, queryKeys.index.pathPrefix);
    },
  });
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/vault/folders/{path}", {
    onSuccess: () => {
      invalidateByPath(qc, queryKeys.pages.pathPrefix);
      invalidateByPath(qc, queryKeys.folders.pathPrefix);
    },
  });
}

export function useUpdatePage() {
  const qc = useQueryClient();
  return $api.useMutation("put", "/api/vault/pages/{path}", {
    onSuccess: () => {
      invalidateByPath(qc, queryKeys.pages.pathPrefix);
      invalidateByPath(qc, queryKeys.index.pathPrefix);
    },
  });
}
