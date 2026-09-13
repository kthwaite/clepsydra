import { $api } from "./client";

export function useSimilar(path: string) {
  return $api.useQuery(
    "get",
    "/api/vault/index/similar/{path}",
    { params: { path: { path } } },
    // Opt out of the global throwOnError: a transient failure (including the
    // service worker's offline_uncached 503 for a page whose "similar" list
    // was never synced) must surface as error state rather than throw into
    // FolioBoundary and blank out the whole folio (same policy as
    // useBacklinks/useOutlinks).
    { enabled: !!path, throwOnError: false },
  );
}
