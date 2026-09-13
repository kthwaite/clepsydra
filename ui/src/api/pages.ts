import { useQueryClient } from "@tanstack/react-query";
import { isOfflineUncached } from "#/offline/swPolicy";
import { $api } from "./client";
import {
  invalidatePageContent,
  invalidatePageStructure,
  invalidateRubbish,
} from "./keys";
import type { components } from "./schema";

export type ArchivedPage = components["schemas"]["RubbishItemSummary"];

export function usePages() {
  return $api.useQuery(
    "get",
    "/api/vault/pages",
    {},
    // Opt out of the global throwOnError: useProjects() calls this
    // unconditionally in Folio before any early return, so an
    // offline_uncached 503 (no synced page list, or a pruned cache) must
    // surface as query `error` state rather than throw into FolioBoundary
    // and blank out the whole folio (same policy as useSimilar).
    { throwOnError: false },
  );
}

/** Local shape check — the api layer must not depend on editor-side helpers. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404
  );
}

export function usePage(path: string) {
  return $api.useQuery(
    "get",
    "/api/vault/pages/{path}",
    { params: { path: { path } } },
    {
      enabled: !!path,
      // Opt out of the global throwOnError so a missing-file 404 surfaces as
      // query `error` state and the folio can render a recovery panel instead
      // of unmounting the whole app.
      throwOnError: false,
      // A 404 is a settled answer — the page does not exist — not a transient
      // failure. Retrying it holds the editor on its loading state for the
      // whole backoff window before draft mode can render. Same for
      // offline_uncached: the service worker already knows this page was
      // never synced to this device, so a retry while still offline cannot
      // succeed and would only hold the folio on "fetching…" for the whole
      // backoff window before "Not available offline" can render. Other
      // failures keep the library default of three attempts.
      retry: (failureCount, error) =>
        !isNotFound(error) && !isOfflineUncached(error) && failureCount < 3,
    },
  );
}

export function useCreatePage() {
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/vault/pages/{path}", {
    onSuccess: () => invalidatePageStructure(qc),
  });
}

export function useMovePage() {
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/vault/pages-move/{path}", {
    onSuccess: () => invalidatePageStructure(qc),
  });
}

export function useArchivePage() {
  const qc = useQueryClient();
  return $api.useMutation("delete", "/api/vault/pages/{path}", {
    onSuccess: () => {
      invalidatePageStructure(qc);
      invalidateRubbish(qc);
    },
  });
}

export function useUpdatePage() {
  const qc = useQueryClient();
  return $api.useMutation("put", "/api/vault/pages/{path}", {
    onSuccess: (data, variables) =>
      invalidatePageContent(qc, variables.params.path.path, data.meta.id),
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
