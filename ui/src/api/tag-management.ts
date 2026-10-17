import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchClient } from "#/api/client";
import { invalidateByPath, invalidatePageContent, queryKeys } from "#/api/keys";
import { NO_SAVE } from "#/api/mutationMeta";
import type { components } from "#/api/schema";

export type TagRenamePreview = components["schemas"]["TagRenamePreview"];
type TagRenameRequest = components["schemas"]["TagRenameRequest"];
type TagRenameApplyRequest = components["schemas"]["TagRenameApplyRequest"];

export function usePreviewTagRename() {
  return useMutation({
    meta: NO_SAVE,
    mutationFn: async (body: TagRenameRequest) => {
      const { data, error } = await fetchClient.POST(
        "/api/vault/index/tags/rename/preview",
        { body },
      );
      if (error) throw error;
      if (!data) throw new Error("Tag preview was empty.");
      return data;
    },
  });
}

export function useApplyTagRename() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: TagRenameApplyRequest) => {
      const { data, error } = await fetchClient.POST(
        "/api/vault/index/tags/rename/apply",
        { body },
      );
      if (error) throw error;
      if (!data) throw new Error("Tag rename result was empty.");
      return data;
    },
    onSuccess: () => {
      invalidatePageContent(client);
      client.invalidateQueries({ queryKey: queryKeys.board.all });
      invalidateByPath(client, queryKeys.bases.pathPrefix);
      invalidateByPath(client, queryKeys.query.pathPrefix);
    },
  });
}
