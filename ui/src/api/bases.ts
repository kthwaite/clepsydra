import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import type { components } from "#/api/schema";
import { $api } from "./client";
import { invalidateByPath, queryKeys } from "./keys";

export type BaseDetailResponse = components["schemas"]["BaseDetailResponse"];
export type PropertyType = components["schemas"]["PropertyType"];
export type PropertyDefinition = components["schemas"]["PropertyDefinition"];
export type QueryOutput = components["schemas"]["QueryOutput"];
export type QueryRow = components["schemas"]["QueryRow"];
export type GroupResult = components["schemas"]["GroupResult"];
export type PropertyPatchRequest =
  components["schemas"]["PropertyPatchRequest"];
export type PropertyPatchResponse =
  components["schemas"]["PropertyPatchResponse"];

export function useBase(slug: string) {
  return $api.useQuery(
    "get",
    "/api/vault/bases/{slug}",
    { params: { path: { slug } } },
    { enabled: !!slug, throwOnError: false },
  );
}

export interface ViewOverrides {
  sort?: string;
  dir?: "asc" | "desc";
}

export function useBaseView(
  slug: string,
  view: string | undefined,
  overrides: ViewOverrides = {},
) {
  return $api.useQuery(
    "get",
    "/api/vault/bases/{slug}/views/{view}",
    {
      params: {
        path: { slug, view: view ?? "" },
        query: {
          sort: overrides.sort,
          dir: overrides.dir,
        },
      },
    },
    { enabled: !!slug && !!view, throwOnError: false },
  );
}

/**
 * The property patch: the cell-edit write path. Sends only the changed keys
 * plus type hints from the base schema; the response embeds the refreshed
 * projections (read-after-write) so callers reconcile without waiting on SSE.
 */
export function usePatchProperties() {
  const qc = useQueryClient();
  return $api.useMutation("patch", "/api/vault/pages/by-id/{uuid}/properties", {
    onSuccess: () => {
      invalidateByPath(qc, queryKeys.bases.pathPrefix);
      invalidateByPath(qc, queryKeys.query.pathPrefix);
    },
  });
}

/**
 * Revision-guarded single-key commit: fetch the page's current revision,
 * PATCH only the changed key (with an optional type hint), and on conflict
 * or failure toast and refetch so the caller shows the winning state.
 */
export function usePropertyCommit() {
  const qc = useQueryClient();
  const patch = usePatchProperties();

  return useCallback(
    async (
      page: { id: string; path: string },
      key: string,
      value: unknown,
      hint?: PropertyType,
    ) => {
      try {
        const pageRes = await fetch(`/api/vault/pages/${page.path}`);
        if (!pageRes.ok)
          throw new Error(`page fetch failed: ${pageRes.status}`);
        const { revision } = (await pageRes.json()) as { revision: string };

        await patch.mutateAsync({
          params: { path: { uuid: page.id } },
          body: {
            set: value === null ? {} : { [key]: value },
            clear: value === null ? [key] : [],
            types: hint ? { [key]: hint } : {},
            expected_revision: revision,
          },
        });
      } catch {
        toast.error(`Could not update ${key} — refreshed to current state`);
        invalidateByPath(qc, queryKeys.bases.pathPrefix);
        invalidateByPath(qc, queryKeys.query.pathPrefix);
      }
    },
    [patch, qc],
  );
}
