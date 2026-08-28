import { useQueryClient } from "@tanstack/react-query";
import { $api } from "./client";
import {
  invalidatePageContent,
  invalidatePageStructure,
  invalidateRubbish,
} from "./keys";
import type { components } from "./schema";

export type ArchivedPage = components["schemas"]["RubbishItemSummary"];

export function usePages() {
  return $api.useQuery("get", "/api/vault/pages");
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
      // whole backoff window before draft mode can render. Other failures keep
      // the library default of three attempts.
      retry: (failureCount, error) => !isNotFound(error) && failureCount < 3,
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
