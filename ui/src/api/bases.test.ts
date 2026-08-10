import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ApiError,
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
  usePropertyCommit,
} from "#/api/bases";
import {
  queryIdentity,
  type BaseEmbedConfig,
} from "#/components/bases/embed-query";
import { fetchClient } from "#/api/client";

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

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function freshQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function seedMutationCaches(queryClient: QueryClient): void {
  for (const queryKey of Object.values(cachedQueryKeys)) {
    queryClient.setQueryData(queryKey, { cached: true });
  }
}

async function expectMutationCachesInvalidated(
  queryClient: QueryClient,
): Promise<void> {
  await waitFor(() => {
    expect(
      queryClient.getQueryState(cachedQueryKeys.baseEvaluation)?.isInvalidated,
    ).toBe(true);
  });
  for (const scope of [
    "baseList",
    "baseDetail",
    "baseView",
    "baseEvaluation",
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
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("preserves generated evaluation ApiError values unchanged", async () => {
    const errors = [
      {
        status: 400,
        error: "invalid embed query",
        hint: "repair the embedded filter",
        detail: {
          code: "invalid_embed_query",
          diagnostics: [
            {
              scope: "embed",
              field: "rating",
              filter_path: "filter",
              message: "rating cannot use contains",
            },
          ],
        },
      },
      {
        status: 409,
        error: "base revision conflict",
        hint: "refresh the Base evaluation",
        detail: { code: "revision_conflict", expected: "rev-2" },
      },
    ] satisfies ApiError[];
    const post = vi.spyOn(fetchClient, "POST");
    const options = baseViewEvaluationOptions({
      base: "books",
      view: "Reading",
      filter: { field: "rating", op: "contains", value: "4" },
    });
    const evaluate = options.queryFn as unknown as () => Promise<
      BaseViewEvaluateResponse
    >;

    for (const wireError of errors) {
      post.mockResolvedValueOnce({ error: wireError } as never);
      const thrown = await evaluate().catch((error: unknown) => error);
      expect(thrown).toBe(wireError);
      expect(thrown).toMatchObject({
        status: wireError.status,
        detail: wireError.detail,
        hint: wireError.hint,
      });
    }
    expect(errors[0].status).not.toBe(errors[1].status);
    expect(errors[1].status).toBe(409);
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

  it("member creation success invalidates every shared mutation cache", async () => {
    const queryClient = freshQueryClient();
    seedMutationCaches(queryClient);
    const post = vi.spyOn(fetchClient, "POST").mockResolvedValueOnce({
      data: {
        id: "018f0f3d-6b9a-7f4b-ae1b-36f6ed681bc5",
        path: "books/dune.md",
        revision: "page-rev-1",
        title: "Dune",
      },
    } as never);
    const { result } = renderHook(() => useCreateBaseMember(), {
      wrapper: wrapper(queryClient),
    });

    await result.current.mutateAsync({
      params: { path: { slug: "books" } },
      body: {
        title: "Dune",
        view: "Reading",
        base_revision: "base-rev-1",
        embed_filter: { field: "status", op: "eq", value: "reading" },
      },
    });

    expect(post).toHaveBeenCalledWith(
      "/api/vault/bases/{slug}/members",
      expect.objectContaining({
        params: { path: { slug: "books" } },
      }),
    );
    await expectMutationCachesInvalidated(queryClient);
  });

  it("property mutation success invalidates every shared mutation cache", async () => {
    const queryClient = freshQueryClient();
    seedMutationCaches(queryClient);
    vi.spyOn(fetchClient, "GET").mockResolvedValueOnce({
      data: { revision: "page-rev-1" },
    } as never);
    const patch = vi.spyOn(fetchClient, "PATCH").mockResolvedValueOnce({
      data: {},
    } as never);
    const { result } = renderHook(() => usePropertyCommit(), {
      wrapper: wrapper(queryClient),
    });

    await result.current(
      {
        id: "018f0f3d-6b9a-7f4b-ae1b-36f6ed681bc5",
        path: "books/dune.md",
      },
      "status",
      "finished",
    );

    expect(patch).toHaveBeenCalledWith(
      "/api/vault/pages/by-id/{uuid}/properties",
      {
        params: {
          path: { uuid: "018f0f3d-6b9a-7f4b-ae1b-36f6ed681bc5" },
        },
        body: {
          set: { status: "finished" },
          clear: [],
          types: {},
          expected_revision: "page-rev-1",
        },
      },
    );
    await expectMutationCachesInvalidated(queryClient);
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
