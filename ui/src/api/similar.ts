import { $api } from "./client";

export function useSimilar(path: string) {
  return $api.useQuery(
    "get",
    "/api/vault/index/similar/{path}",
    { params: { path: { path } } },
    { enabled: !!path },
  );
}
