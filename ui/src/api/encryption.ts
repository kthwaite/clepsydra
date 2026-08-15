import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { clearBlockDetailsForPagePaths } from "./blocks";
import { $api } from "./client";
import { invalidateByPath, invalidatePageContent, queryKeys } from "./keys";

function invalidateEncryptionConfig(queryClient: QueryClient) {
  invalidateByPath(queryClient, queryKeys.encryption.pathPrefix);
}

function invalidateProtectedPage(
  queryClient: QueryClient,
  path: string,
  uuid: string,
) {
  invalidatePageContent(queryClient, path, uuid);
  invalidateByPath(queryClient, queryKeys.folders.pathPrefix);
}

export function useEncryptionConfig() {
  return $api.useQuery("get", "/api/vault/encryption");
}

export function useSetupEncryption() {
  const queryClient = useQueryClient();
  return $api.useMutation("post", "/api/vault/encryption/setup", {
    onSuccess: () => invalidateEncryptionConfig(queryClient),
  });
}

export function useRewrapIdentity() {
  const queryClient = useQueryClient();
  return $api.useMutation("put", "/api/vault/encryption/wrapped-identity", {
    onSuccess: () => invalidateEncryptionConfig(queryClient),
  });
}

export function useProtectPage() {
  const queryClient = useQueryClient();
  return $api.useMutation("post", "/api/vault/pages/by-id/{uuid}/protect", {
    onSuccess: (page, variables) => {
      void clearBlockDetailsForPagePaths(queryClient, [page.path]);
      invalidateProtectedPage(
        queryClient,
        page.path,
        variables.params.path.uuid,
      );
    },
  });
}

export function useUnprotectPage() {
  const queryClient = useQueryClient();
  return $api.useMutation("post", "/api/vault/pages/by-id/{uuid}/unprotect", {
    onSuccess: (page, variables) =>
      invalidateProtectedPage(
        queryClient,
        page.path,
        variables.params.path.uuid,
      ),
  });
}
