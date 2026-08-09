import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import type { components } from "#/api/schema";
import { $api, fetchClient } from "./client";
import { isApiError } from "./error";
import { invalidateByPath, queryKeys } from "./keys";

export type BaseDetailResponse = components["schemas"]["BaseDetailResponse"];
export type BaseMemberCreateRequest =
  components["schemas"]["BaseMemberCreateRequest"];
export type BaseMemberCreateResponse =
  components["schemas"]["BaseMemberCreateResponse"];
export type BaseMemberCapability =
  components["schemas"]["BaseMemberCapability"];
export type BaseMemberDiagnostic =
  components["schemas"]["BaseMemberDiagnostic"];
export type BaseFile = components["schemas"]["BaseFile"];
export type BaseListResponse = components["schemas"]["BaseListResponse"];
export type BaseSummary = components["schemas"]["BaseSummary"];
export type BaseMutationResponse =
  components["schemas"]["BaseMutationResponse"];
export type CreateBaseRequest = components["schemas"]["CreateBaseRequest"];
export type BasePreviewResponse = components["schemas"]["BasePreviewResponse"];
export type BaseFilter = components["schemas"]["Filter"];
export type FilterOp = components["schemas"]["Op"];
export type SortKey = components["schemas"]["SortKey"];
export type Aggregate = components["schemas"]["Aggregate"];
export type PropertyType = components["schemas"]["PropertyType"];
export type PropertyDefinition = components["schemas"]["PropertyDefinition"];
export type QueryOutput = components["schemas"]["QueryOutput"];
export type QueryRow = components["schemas"]["QueryRow"];
export type GroupResult = components["schemas"]["GroupResult"];

const BASE_MEMBER_SCOPES: ReadonlySet<string> = new Set([
  "membership",
  "view",
  "field",
]);

function isBaseMemberDiagnostic(
  value: unknown,
): value is BaseMemberDiagnostic {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (
    !("scope" in value) ||
    typeof value.scope !== "string" ||
    !BASE_MEMBER_SCOPES.has(value.scope) ||
    !("message" in value) ||
    typeof value.message !== "string"
  ) {
    return false;
  }
  if (
    "field" in value &&
    value.field !== null &&
    typeof value.field !== "string"
  ) {
    return false;
  }
  return (
    !("filter_path" in value) ||
    value.filter_path === null ||
    typeof value.filter_path === "string"
  );
}

export function decodeBaseMemberDiagnostics(
  error: unknown,
): BaseMemberDiagnostic[] {
  if (
    !isApiError(error) ||
    typeof error.detail !== "object" ||
    !error.detail ||
    !("diagnostics" in error.detail)
  ) {
    return [];
  }
  const diagnostics = error.detail.diagnostics;
  if (
    !Array.isArray(diagnostics) ||
    !diagnostics.every(isBaseMemberDiagnostic)
  ) {
    return [];
  }
  return diagnostics;
}

function useInvalidateBaseQueries() {
  const qc = useQueryClient();
  return useCallback(() => {
    invalidateByPath(qc, queryKeys.bases.pathPrefix);
    invalidateByPath(qc, queryKeys.query.pathPrefix);
  }, [qc]);
}

export function invalidateBaseMemberQueries(queryClient: QueryClient): void {
  invalidateByPath(queryClient, queryKeys.bases.pathPrefix);
  invalidateByPath(queryClient, queryKeys.query.pathPrefix);
  invalidateByPath(queryClient, queryKeys.pages.pathPrefix);
}

export const useBases = () => $api.useQuery("get", "/api/vault/bases", {});

export function useCreateBase() {
  const onSuccess = useInvalidateBaseQueries();
  return $api.useMutation("post", "/api/vault/bases", { onSuccess });
}

export function useCreateBaseMember() {
  const queryClient = useQueryClient();
  return $api.useMutation("post", "/api/vault/bases/{slug}/members", {
    onSuccess: () => invalidateBaseMemberQueries(queryClient),
  });
}

export function useUpdateBase() {
  const onSuccess = useInvalidateBaseQueries();
  return $api.useMutation("put", "/api/vault/bases/{slug}", { onSuccess });
}

export function useDeleteBase() {
  const onSuccess = useInvalidateBaseQueries();
  return $api.useMutation("delete", "/api/vault/bases/{slug}", { onSuccess });
}

export const usePreviewBase = () =>
  $api.useMutation("post", "/api/vault/bases/preview");

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
function usePatchProperties() {
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
        // The generated client's path-parameter encoding matches the page
        // routes exactly (a raw template literal would break on # or %).
        const pageRes = await fetchClient.GET("/api/vault/pages/{path}", {
          params: { path: { path: page.path } },
        });
        const revision = pageRes.data?.revision;
        if (!revision) throw new Error("page revision fetch failed");

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
