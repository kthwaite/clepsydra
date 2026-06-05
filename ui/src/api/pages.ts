import { useQueryClient } from "@tanstack/react-query";
import { $api } from "./client";
import {
  invalidateByPath,
  invalidatePageContent,
  invalidatePageStructure,
  queryKeys,
} from "./keys";

export function usePages() {
  return $api.useQuery("get", "/api/vault/pages");
}

export function usePage(path: string) {
  return $api.useQuery(
    "get",
    "/api/vault/pages/{path}",
    { params: { path: { path } } },
    // Opt out of the global throwOnError so a missing-file 404 surfaces as
    // query `error` state and the folio can render a recovery panel instead of
    // unmounting the whole app.
    { enabled: !!path, throwOnError: false },
  );
}

export function useFolderTreePaths() {
  const query = $api.useQuery("get", "/api/vault/folders/tree");
  return { ...query, data: query.data?.paths };
}

export function useCreatePage() {
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/vault/pages/{path}", {
    onSuccess: () => invalidatePageStructure(qc),
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
    onSuccess: (_data, variables) =>
      invalidatePageContent(qc, variables.params.path.path),
  });
}

export function useAssignPage() {
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/vault/pages-assign/{path}", {
    onSuccess: () => invalidatePageStructure(qc),
  });
}

export function useAssignBulk() {
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/vault/pages-assign-bulk", {
    onSuccess: () => invalidatePageStructure(qc),
  });
}
