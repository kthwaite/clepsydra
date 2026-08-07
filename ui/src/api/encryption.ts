import { useQueryClient } from "@tanstack/react-query";
import { $api } from "./client";
import { invalidateByPath, invalidatePageContent, queryKeys } from "./keys";

function invalidateEncryptionConfig(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  invalidateByPath(queryClient, queryKeys.encryption.pathPrefix);
}

function invalidateProtectedPage(
  queryClient: ReturnType<typeof useQueryClient>,
  path: string,
) {
  invalidatePageContent(queryClient, path);
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
    onSuccess: (page) => invalidateProtectedPage(queryClient, page.path),
  });
}

export function useUnprotectPage() {
  const queryClient = useQueryClient();
  return $api.useMutation("post", "/api/vault/pages/by-id/{uuid}/unprotect", {
    onSuccess: (page) => invalidateProtectedPage(queryClient, page.path),
  });
}
