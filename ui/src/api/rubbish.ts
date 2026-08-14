import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { components } from "#/api/schema";
import { $api, fetchClient } from "./client";
import { invalidatePageStructure, invalidateRubbish } from "./keys";

export type RubbishListEntry = components["schemas"]["RubbishListEntryDto"];
export type RubbishItemSummary = components["schemas"]["RubbishItemSummary"];
export type RubbishItemDetail = components["schemas"]["RubbishItemDetail"];
export type RubbishRestoreResponse =
  components["schemas"]["RubbishRestoreResponse"];
export type RubbishPurgeResponse =
  components["schemas"]["RubbishPurgeResponse"];
export type EmptyRubbishResponse =
  components["schemas"]["EmptyRubbishResponse"];

function requiredResponse<T>(
  data: T | undefined,
  error: unknown,
  fallback: string,
): T {
  if (error !== undefined) throw error;
  if (data === undefined) throw new Error(fallback);
  return data;
}

export function useRubbishList() {
  return $api.useQuery("get", "/api/vault/rubbish", undefined, {
    throwOnError: false,
  });
}

export function useRubbishItem(itemId: string | null) {
  return $api.useQuery(
    "get",
    "/api/vault/rubbish/{item_id}",
    { params: { path: { item_id: itemId ?? "" } } },
    { enabled: itemId !== null, throwOnError: false },
  );
}

export function useRestoreRubbishItem() {
  const queryClient = useQueryClient();
  return useMutation<RubbishRestoreResponse, unknown, string>({
    mutationFn: async (itemId) => {
      const { data, error } = await fetchClient.POST(
        "/api/vault/rubbish/{item_id}/restore",
        { params: { path: { item_id: itemId } } },
      );
      return requiredResponse(data, error, "Restore returned no result.");
    },
    onSuccess: () => {
      invalidateRubbish(queryClient);
      invalidatePageStructure(queryClient);
    },
  });
}

export function usePurgeRubbishItem() {
  const queryClient = useQueryClient();
  return useMutation<RubbishPurgeResponse, unknown, string>({
    mutationFn: async (itemId) => {
      const { data, error } = await fetchClient.DELETE(
        "/api/vault/rubbish/{item_id}",
        { params: { path: { item_id: itemId } } },
      );
      return requiredResponse(
        data,
        error,
        "Permanent deletion returned no result.",
      );
    },
    onSuccess: () => {
      void invalidateRubbish(queryClient);
    },
  });
}

export function useEmptyRubbish() {
  const queryClient = useQueryClient();
  return useMutation<EmptyRubbishResponse, unknown, void>({
    mutationFn: async () => {
      const { data, error } = await fetchClient.DELETE("/api/vault/rubbish");
      return requiredResponse(
        data,
        error,
        "Empty Rubbish Bin returned no result.",
      );
    },
    onSuccess: () => {
      void invalidateRubbish(queryClient);
    },
  });
}
