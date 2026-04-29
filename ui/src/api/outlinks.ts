import { $api } from "./client";

export function useOutlinks(path: string) {
  return $api.useQuery(
    "get",
    "/api/vault/index/outlinks/{path}",
    { params: { path: { path } } },
    { enabled: !!path },
  );
}
