import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  decodeBaseMemberDiagnostics,
  invalidateBaseMemberQueries,
  useCreateBaseMember,
} from "#/api/bases";

const cachedQueryKeys = {
  baseList: ["get", "/api/vault/bases"] as const,
  baseDetail: ["get", "/api/vault/bases/{slug}", { slug: "books" }] as const,
  baseView: [
    "get",
    "/api/vault/bases/{slug}/views/{view}",
    { slug: "books", view: "continues" },
  ] as const,
  query: ["post", "/api/vault/query", { filter: "kind == NOTE" }] as const,
  pageList: ["get", "/api/vault/pages"] as const,
  pageDetail: ["get", "/api/vault/pages/{path}", { path: "books/dune.md" }] as const,
  folderList: ["get", "/api/vault/folders"] as const,
};

describe("Base member API", () => {
  it("exports the generated mutation hook", () => {
    expect(typeof useCreateBaseMember).toBe("function");
  });

  it("decodes diagnostics only from the structured API error detail", () => {
    expect(
      decodeBaseMemberDiagnostics({
        status: 422,
        error: "candidate rejected",
        detail: {
          diagnostics: [
            {
              scope: "view",
              field: "status",
              message: "must equal reading",
            },
          ],
        },
      }),
    ).toEqual([
      {
        scope: "view",
        field: "status",
        message: "must equal reading",
      },
    ]);
    expect(
      decodeBaseMemberDiagnostics({ status: 500, error: "failed" }),
    ).toEqual([]);
    expect(
      decodeBaseMemberDiagnostics({
        error: "candidate rejected",
        detail: { diagnostics: "invalid" },
      }),
    ).toEqual([]);
    expect(
      decodeBaseMemberDiagnostics({
        detail: { diagnostics: [{ scope: "view", message: "ignored" }] },
      }),
    ).toEqual([]);
  });

  it("invalidates Base, query, and page caches without invalidating other scopes", () => {
    const queryClient = new QueryClient();
    for (const queryKey of Object.values(cachedQueryKeys)) {
      queryClient.setQueryData(queryKey, { cached: true });
    }

    invalidateBaseMemberQueries(queryClient);

    for (const scope of [
      "baseList",
      "baseDetail",
      "baseView",
      "query",
      "pageList",
      "pageDetail",
    ] as const) {
      expect(
        queryClient.getQueryState(cachedQueryKeys[scope])?.isInvalidated,
        scope,
      ).toBe(true);
    }
    expect(
      queryClient.getQueryState(cachedQueryKeys.folderList)?.isInvalidated,
    ).toBe(false);
  });
});
