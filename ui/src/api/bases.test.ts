import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  type BaseMemberCapability,
  type BaseMemberCreateRequest,
  type BaseMemberDiagnostic,
  type BaseViewEvaluateRequest,
  type BaseViewEvaluateResponse,
  baseViewEvaluationOptions,
  decodeBaseMemberDiagnostics,
  invalidateBaseMutationQueries,
  useBaseViewEvaluation,
  useCreateBaseMember,
} from "#/api/bases";
import {
  queryIdentity,
  type BaseEmbedConfig,
} from "#/components/bases/embed-query";

const cachedQueryKeys = {
  baseList: ["get", "/api/vault/bases"] as const,
  baseDetail: ["get", "/api/vault/bases/{slug}", { slug: "books" }] as const,
  baseView: [
    "get",
    "/api/vault/bases/{slug}/views/{view}",
    { slug: "books", view: "continues" },
  ] as const,
  baseEvaluation: [
    "post",
    "/api/vault/bases/{slug}/views/{view}/evaluate",
    "books-reading-evaluation",
  ] as const,
  query: ["post", "/api/vault/query", { filter: "kind == NOTE" }] as const,
  pageList: ["get", "/api/vault/pages"] as const,
  pageDetail: ["get", "/api/vault/pages/{path}", { path: "books/dune.md" }] as const,
  folderList: ["get", "/api/vault/folders"] as const,
};

describe("Base member API", () => {
  it("exports generated embed DTOs and API hooks with exact wire names", () => {
    const request: BaseMemberCreateRequest = {
      title: "Dune",
      view: "Reading",
      base_revision: "rev-1",
      embed_filter: { field: "status", op: "eq", value: "reading" },
    };
    const capability: BaseMemberCapability = {
      view: "Reading",
      enabled: true,
      blockers: [],
      fields: [
        {
          field: "status",
          membership: false,
          view: false,
          embed: true,
        },
        {
          field: "rating",
          membership: true,
          view: true,
          embed: false,
        },
      ],
    };
    const diagnostic: BaseMemberDiagnostic = {
      scope: "embed",
      field: "status",
      filter_path: "embed_filter",
      message: "must match the embedded filter",
    };
    const evaluationRequest: BaseViewEvaluateRequest = {
      filter: request.embed_filter,
      sort: [],
      limit: 50,
    };
    const evaluationResponse: BaseViewEvaluateResponse = {
      revision: "rev-1",
      member_creation: capability,
      output: { shape: "flat", rows: [], total: 0 },
    };

    expect(request.embed_filter).toEqual(evaluationRequest.filter);
    expect(capability.fields.map(({ embed }) => embed)).toEqual([true, false]);
    expect(diagnostic.scope).toBe("embed");
    expect(evaluationResponse.member_creation).toBe(capability);
    expect(typeof useCreateBaseMember).toBe("function");
    expect(typeof useBaseViewEvaluation).toBe("function");
  });

  it("decodes only diagnostics whose complete runtime shape is valid", () => {
    const validDiagnostics = [
      {
        scope: "membership" as const,
        message: "must match the Base filter",
      },
      {
        scope: "view" as const,
        field: null,
        filter_path: "views[0].filter",
        message: "must equal reading",
      },
      {
        scope: "embed" as const,
        field: "rating",
        filter_path: "embed_filter",
        message: "must be at least four",
      },
      {
        scope: "field" as const,
        field: "status",
        filter_path: null,
        message: "status cannot be persisted",
      },
    ];
    expect(
      decodeBaseMemberDiagnostics({
        status: 422,
        error: "candidate rejected",
        detail: { diagnostics: validDiagnostics },
      }),
    ).toEqual(validDiagnostics);

    for (const diagnostics of [
      [null],
      [{ scope: "other", message: "invalid scope" }],
      [{ scope: "view", message: 42 }],
      [{ scope: "view", message: "invalid field", field: false }],
      [{ scope: "view", message: "invalid path", filter_path: 1 }],
      [
        { scope: "view", message: "valid" },
        { scope: "field", message: "one invalid entry poisons the array", field: {} },
      ],
    ]) {
      expect(
        decodeBaseMemberDiagnostics({
          status: 422,
          error: "candidate rejected",
          detail: { diagnostics },
        }),
      ).toEqual([]);
    }

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
        detail: { diagnostics: validDiagnostics },
      }),
    ).toEqual([]);
  });

  it("builds distinct normalized POST keys for distinct evaluations", () => {
    const first: BaseEmbedConfig = {
      base: "books",
      view: "Reading",
      filter: { field: "status", op: "eq", value: "reading" },
    };
    const second: BaseEmbedConfig = {
      ...first,
      filter: { field: "status", op: "eq", value: "finished" },
    };
    const firstOptions = baseViewEvaluationOptions(first);
    const secondOptions = baseViewEvaluationOptions(second);
    const queryClient = new QueryClient();

    expect(firstOptions.queryKey).toEqual([
      "post",
      "/api/vault/bases/{slug}/views/{view}/evaluate",
      queryIdentity(first),
    ]);
    expect(secondOptions.queryKey).not.toEqual(firstOptions.queryKey);
    queryClient.setQueryData(firstOptions.queryKey, {
      revision: "rev-1",
      member_creation: {
        view: "Reading",
        enabled: true,
        blockers: [],
        fields: [],
      },
      output: { shape: "flat", rows: [], total: 0 },
    });
    expect(queryClient.getQueryData(secondOptions.queryKey)).toBeUndefined();
  });

  it("invalidates Base, query, and page caches without invalidating other scopes", () => {
    const queryClient = new QueryClient();
    for (const queryKey of Object.values(cachedQueryKeys)) {
      queryClient.setQueryData(queryKey, { cached: true });
    }

    invalidateBaseMutationQueries(queryClient);

    for (const scope of [
      "baseList",
      "baseDetail",
      "baseView",
      "query",
      "baseEvaluation",
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
