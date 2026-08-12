import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchClient } from "#/api/client";
import {
  ReferenceRepairApiError,
  type ReferenceIssueFilters,
  useApplyReferenceRepair,
  usePreviewReferenceRepair,
  useReferenceIssues,
} from "#/api/index";
import { queryKeys } from "#/api/keys";

const transport = vi.hoisted(() => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const NativeRequest = globalThis.Request;
  class SameOriginRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(
        typeof input === "string" && input.startsWith("/")
          ? new URL(input, "http://localhost")
          : input,
        init,
      );
    }
  }
  vi.stubGlobal("Request", SameOriginRequest);
  vi.stubGlobal("fetch", fetch);
  return { fetch };
});

const issue = {
  actions: ["replace" as const],
  candidates: [
    {
      page_id: "page-target",
      path: "notes/target.md",
      rationale: "Exact title match",
      title: "Target",
    },
  ],
  fingerprint: "fp-1",
  kind: "unresolved_page_link" as const,
  source_id: "page-source",
  source_path: "notes/source.md",
  source_revision: "rev-1",
  target_raw: "Target",
};

const issuesResponse = {
  items: [issue],
  limit: 25,
  offset: 50,
  total: 1,
};

const request = {
  action: { type: "replace" as const, candidate_page_id: "page-target" },
  fingerprint: "fp-1",
  source_revision: "rev-1",
};

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

beforeEach(() => transport.fetch.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("useReferenceIssues", () => {
  it("serializes every filter into the transport URL and cache key", async () => {
    transport.fetch.mockResolvedValue(
      new Response(JSON.stringify(issuesResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const filters: ReferenceIssueFilters = {
      kind: ["unresolved_page_link", "orphan_page"],
      project: "Atlas",
      pageKind: "PROJECT",
      actionable: false,
      limit: 25,
      offset: 50,
    };
    const { client, wrapper } = harness();
    const { result } = renderHook(() => useReferenceIssues(filters), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const query: Parameters<typeof queryKeys.index.issues>[0] = {
      kind: ["unresolved_page_link", "orphan_page"],
      project: "Atlas",
      page_kind: "PROJECT",
      actionable: false,
      limit: 25,
      offset: 50,
    };
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    const sentRequest = transport.fetch.mock.calls[0]?.[0] as Request;
    const sentUrl = new URL(sentRequest.url);
    expect(`${sentUrl.pathname}${sentUrl.search}`).toBe(
      "/api/vault/index/issues?kind=unresolved_page_link&kind=orphan_page&project=Atlas&page_kind=PROJECT&actionable=false&limit=25&offset=50",
    );
    expect(client.getQueryCache().getAll()[0]?.queryKey).toEqual(
      queryKeys.index.issues(query),
    );
    expect(result.current.data).toEqual(issuesResponse);
  });

  it("omits empty filters and reuses the cache entry across object identities", async () => {
    transport.fetch.mockResolvedValue(
      new Response(JSON.stringify({ ...issuesResponse, limit: 50, offset: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { client, wrapper } = harness();
    const { result, rerender } = renderHook(
      ({ filters }: { filters: ReferenceIssueFilters }) =>
        useReferenceIssues(filters),
      {
        initialProps: { filters: { kind: [], project: "" } },
        wrapper,
      },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    rerender({ filters: { kind: [], project: "" } });

    expect(transport.fetch).toHaveBeenCalledTimes(1);
    const sentRequest = transport.fetch.mock.calls[0]?.[0] as Request;
    const sentUrl = new URL(sentRequest.url);
    expect(`${sentUrl.pathname}${sentUrl.search}`).toBe(
      "/api/vault/index/issues",
    );
    expect(client.getQueryCache().getAll()).toHaveLength(1);
    expect(client.getQueryCache().getAll()[0]?.queryKey).toEqual(
      queryKeys.index.issues({}),
    );
  });
});

describe("reference repair mutations", () => {
  it("forwards the fingerprint, revision, and action to preview and apply", async () => {
    const post = vi.spyOn(fetchClient, "POST").mockImplementation(async (path) => {
      if (path === "/api/vault/index/issues/preview") {
        return {
          data: {
            after: "[[Target]]",
            before: "[[Missing]]",
            fingerprint: "fp-1",
            plan: { file_ops: [], text_edits: [] },
          },
          error: undefined,
          response: new Response(null, { status: 200 }),
        } as never;
      }
      return {
        data: {
          fingerprint: "fp-1",
          notification: { removed: [], upserted: ["notes/source.md"] },
        },
        error: undefined,
        response: new Response(null, { status: 200 }),
      } as never;
    });
    const { wrapper } = harness();
    const preview = renderHook(() => usePreviewReferenceRepair(), { wrapper });
    const apply = renderHook(() => useApplyReferenceRepair(), { wrapper });

    await act(() => preview.result.current.mutateAsync(request));
    await act(() => apply.result.current.mutateAsync(request));

    expect(post).toHaveBeenNthCalledWith(
      1,
      "/api/vault/index/issues/preview",
      { body: request },
    );
    expect(post).toHaveBeenNthCalledWith(2, "/api/vault/index/issues/apply", {
      body: request,
    });
  });

  it("keeps issue rows during apply and invalidates only affected paths on success", async () => {
    const { client, wrapper } = harness();
    const issuesKey = queryKeys.index.issues({ project: "Atlas" });
    const affectedKeys = [
      issuesKey,
      ["get", queryKeys.index.graphPath],
      ["get", queryKeys.pages.pathPrefix],
      ["get", queryKeys.query.pathPrefix],
      ["get", queryKeys.bases.pathPrefix],
    ] as const;
    const unaffectedKey = ["get", "/api/vault/index/tags"] as const;
    for (const key of affectedKeys) client.setQueryData(key, issuesResponse);
    client.setQueryData(unaffectedKey, { items: [] });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    vi.spyOn(fetchClient, "POST").mockImplementation(async () => {
      expect(invalidate).not.toHaveBeenCalled();
      expect(client.getQueryData(issuesKey)).toEqual(issuesResponse);
      return {
        data: {
          fingerprint: "fp-1",
          notification: { removed: [], upserted: ["notes/source.md"] },
        },
        error: undefined,
        response: new Response(null, { status: 200 }),
      } as never;
    });
    const { result } = renderHook(() => useApplyReferenceRepair(), { wrapper });

    await act(() => result.current.mutateAsync(request));

    expect(invalidate).toHaveBeenCalledTimes(5);
    for (const key of affectedKeys) {
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    }
    expect(client.getQueryState(unaffectedKey)?.isInvalidated).toBe(false);
    expect(client.getQueryData(issuesKey)).toEqual(issuesResponse);
  });

  it("preserves typed preview and apply HTTP errors without invalidating cached data", async () => {
    const serverError = {
      detail: { fingerprint: "fp-1" },
      error: "stale reference",
      hint: "Refresh the issue inventory.",
      status: 409,
    };
    transport.fetch.mockImplementation(async () => {
      return new Response(JSON.stringify(serverError), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    });
    const { client, wrapper } = harness();
    const issuesKey = queryKeys.index.issues({});
    client.setQueryData(issuesKey, issuesResponse);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const preview = renderHook(() => usePreviewReferenceRepair(), { wrapper });
    const apply = renderHook(() => useApplyReferenceRepair(), { wrapper });

    await expect(
      preview.result.current.mutateAsync(request),
    ).rejects.toBeInstanceOf(ReferenceRepairApiError);
    await expect(
      apply.result.current.mutateAsync(request),
    ).rejects.toBeInstanceOf(ReferenceRepairApiError);
    await waitFor(() => {
      expect(preview.result.current.isError).toBe(true);
      expect(apply.result.current.isError).toBe(true);
    });

    for (const error of [
      preview.result.current.error,
      apply.result.current.error,
    ]) {
      expect(error).toBeInstanceOf(ReferenceRepairApiError);
      if (!(error instanceof ReferenceRepairApiError)) {
        throw new Error("Expected a typed reference repair error.");
      }
      expect(error.message).toBe("stale reference");
      expect(error.status).toBe(409);
      expect(error.payload).toEqual(serverError);
      expect(error.cause).toEqual(serverError);
    }
    expect(invalidate).not.toHaveBeenCalled();
    expect(client.getQueryData(issuesKey)).toEqual(issuesResponse);
  });
});
