import { $api } from "./client";

export function useBacklinks(path: string) {
  return $api.useQuery(
    "get",
    "/api/vault/index/backlinks/{path}",
    { params: { path: { path } } },
    { enabled: !!path },
  );
}

export function useTags(enabled = true) {
  return $api.useQuery("get", "/api/vault/index/tags", {}, { enabled });
}

export function useStats() {
  return $api.useQuery("get", "/api/vault/index/stats");
}

export function useGraph() {
  return $api.useQuery("get", "/api/vault/index/graph");
}

export function useSearch(query: string, limit?: number) {
  return $api.useQuery(
    "get",
    "/api/vault/index/search",
    { params: { query: { q: query, limit } } },
    { enabled: query.length > 0 },
  );
}

export function useContentIndex(limit?: number, offset?: number) {
  return $api.useQuery("get", "/api/vault/index/content-index", {
    params: { query: { limit, offset } },
  });
}

export { useOutlinks } from "./outlinks";
export { useSimilar } from "./similar";
