import { $api } from "./client";

export function useOutlinks(path: string) {
  return $api.useQuery(
    "get",
    "/api/vault/index/outlinks/{path}",
    { params: { path: { path } } },
    // Opt out of the global throwOnError: a missing-path 404 must surface as
    // error state rather than throw during render (the folio handles the
    // missing case via usePage's error).
    { enabled: !!path, throwOnError: false },
  );
}
