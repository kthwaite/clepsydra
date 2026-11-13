import { useMutation, useQueryClient } from "@tanstack/react-query";
import { $api, fetchClient } from "#/api/client";
import { isApiError } from "#/api/error";
import { invalidateByPath, queryKeys } from "#/api/keys";
import type { components } from "#/api/schema";

export type SavedQuire = components["schemas"]["SavedQuire"];
export type CreateSavedQuire = components["schemas"]["CreateSavedQuire"];
export type UpdateSavedQuire = components["schemas"]["UpdateSavedQuire"];

function requireResult<T>(
  data: T | undefined,
  error: unknown,
  response: Response,
): T {
  if (error !== undefined) {
    if (isApiError(error)) throw { ...error, status: response.status };
    throw error;
  }
  if (data === undefined)
    throw new Error("The server returned no saved quire.");
  return data;
}

export function useSavedQuires() {
  return $api.useQuery("get", "/api/vault/quires", undefined, {
    throwOnError: false,
  });
}

export async function fetchSavedQuire(id: string): Promise<SavedQuire> {
  const { data, error, response } = await fetchClient.GET(
    "/api/vault/quires/{id}",
    {
      params: { path: { id } },
    },
  );
  return requireResult(data, error, response);
}

export function useCreateSavedQuire() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateSavedQuire) => {
      const { data, error, response } = await fetchClient.POST(
        "/api/vault/quires",
        { body },
      );
      return requireResult(data, error, response);
    },
    onSuccess: () => {
      void invalidateByPath(client, queryKeys.quires.pathPrefix);
    },
  });
}

export function useUpdateSavedQuire() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: UpdateSavedQuire;
    }) => {
      const { data, error, response } = await fetchClient.PUT(
        "/api/vault/quires/{id}",
        {
          params: { path: { id } },
          body,
        },
      );
      return requireResult(data, error, response);
    },
    onSuccess: () => {
      void invalidateByPath(client, queryKeys.quires.pathPrefix);
    },
  });
}

export function useDeleteSavedQuire() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, revision }: { id: string; revision: string }) => {
      const { error, response } = await fetchClient.DELETE(
        "/api/vault/quires/{id}",
        {
          params: { path: { id }, query: { expected_revision: revision } },
        },
      );
      if (error !== undefined) {
        if (isApiError(error)) throw { ...error, status: response.status };
        throw error;
      }
    },
    onSuccess: () => {
      void invalidateByPath(client, queryKeys.quires.pathPrefix);
    },
  });
}
