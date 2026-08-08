import type { components, operations } from "./schema";

type JsonResponse<T> = T extends {
  content: { "application/json": infer Response };
}
  ? Response
  : never;

type JsonRequestBody<TOperation extends keyof operations> =
  operations[TOperation] extends {
    requestBody?: { content: { "application/json": infer Body } };
  }
    ? Body
    : never;

export type ApiError = components["schemas"]["ApiError"];

export type PageSummary = components["schemas"]["PageSummary"];
export type PageMeta = components["schemas"]["PageMetaResponse"];
export type PageDetail = JsonResponse<operations["get_page"]["responses"][200]>;
export type PageListResponse = JsonResponse<
  operations["list_pages"]["responses"][200]
>;
export type ListPagesQuery = operations["list_pages"]["parameters"]["query"];
export type PagePathParams = operations["get_page"]["parameters"]["path"];
export type CreatePagePathParams =
  operations["create_page"]["parameters"]["path"];
export type CreatePageRequest = JsonRequestBody<"create_page">;
export type CreatePageResponse = JsonResponse<
  operations["create_page"]["responses"][201]
>;

export type FolderInfo = components["schemas"]["FolderInfo"];
export type FolderListing = JsonResponse<
  operations["list_folder_contents"]["responses"][200]
>;
export type ListFoldersResponse = JsonResponse<
  operations["list_folders"]["responses"][200]
>;
export type FolderPathParams =
  operations["list_folder_contents"]["parameters"]["path"];
export type CreateFolderPathParams =
  operations["create_folder"]["parameters"]["path"];
export type CreateFolderResponse = JsonResponse<
  operations["create_folder"]["responses"][201]
>;
export type FolderTreeResponse = JsonResponse<
  operations["list_folder_tree"]["responses"][200]
>;

export type BacklinkEntry = components["schemas"]["BacklinkEntry"];
export type BacklinksResponse = JsonResponse<
  operations["backlinks"]["responses"][200]
>;
export type BacklinksPathParams = operations["backlinks"]["parameters"]["path"];

export type GraphResponse = JsonResponse<operations["graph"]["responses"][200]>;
export type GraphNode = components["schemas"]["GraphNode"];
export type GraphEdge = components["schemas"]["GraphEdge"];

export type TagCount = components["schemas"]["TagCount"];
export type TagCountsResponse = JsonResponse<
  operations["tags"]["responses"][200]
>;
export type VaultStats = JsonResponse<operations["stats"]["responses"][200]>;
export type ContentEntry = components["schemas"]["ContentEntry"];

export type SearchResult = components["schemas"]["SearchResultEntry"];
export type SearchResponse = JsonResponse<
  operations["search"]["responses"][200]
>;
export type SearchQueryParams = operations["search"]["parameters"]["query"];

export type BulkAssignRequest = components["schemas"]["BulkAssignRequest"];
export type BulkAssignResponse = components["schemas"]["BulkAssignResponse"];
