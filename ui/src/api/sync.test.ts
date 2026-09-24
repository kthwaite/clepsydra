import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchClient } from "#/api/client";
import { queryKeys } from "#/api/keys";
import {
  SyncConflictApiError,
  useConflictCompare,
  useResolveConflict,
} from "#/api/sync";

function freshQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
  });
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

const request = {
  copy: "notes/plan.conflict.abc1234.md",
  merged: "---\ntitle: Plan\n---\nbody\n",
  original_revision: "rev-local",
  copy_revision: "rev-other",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useConflictCompare", () => {
  it("fetches the compare view for the copy path", async () => {
    const get = vi.spyOn(fetchClient, "GET").mockResolvedValue({
      data: { copy_path: request.copy },
      response: new Response(null, { status: 200 }),
    } as never);
    const queryClient = freshQueryClient();
    const { result } = renderHook(() => useConflictCompare(request.copy), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith("/api/vault/sync/conflicts/compare", {
      params: { query: { copy: request.copy } },
    });
  });

  it("is not refreshed by the vault-event invalidation of the sync prefix", async () => {
    const queryClient = freshQueryClient();
    queryClient.setQueryData(queryKeys.sync.compare(request.copy), {});
    await queryClient.invalidateQueries({ queryKey: queryKeys.sync.prefix });
    expect(
      queryClient.getQueryState(queryKeys.sync.compare(request.copy))
        ?.isInvalidated,
    ).toBe(false);
  });

  it("throws the status and detail code of an error", async () => {
    vi.spyOn(fetchClient, "GET").mockResolvedValue({
      error: {
        error: "encrypted",
        status: 422,
        detail: { code: "resolve_by_hand" },
      },
      response: new Response(null, { status: 422 }),
    } as never);
    const queryClient = freshQueryClient();
    const { result } = renderHook(() => useConflictCompare(request.copy), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const error = result.current.error;
    expect(error).toBeInstanceOf(SyncConflictApiError);
    expect(error).toMatchObject({
      status: 422,
      code: "resolve_by_hand",
      message: "encrypted",
    });
  });
});

describe("useResolveConflict", () => {
  it("posts the request and invalidates conflicts, pages and the bin", async () => {
    const post = vi.spyOn(fetchClient, "POST").mockResolvedValue({
      data: { original_path: "notes/plan.md", archived: {} },
      response: new Response(null, { status: 200 }),
    } as never);
    const queryClient = freshQueryClient();
    const keys = {
      conflicts: queryKeys.sync.conflicts(),
      rubbish: queryKeys.rubbish.all,
      page: [
        "get",
        "/api/vault/pages/{path}",
        { params: { path: { path: "notes/plan.md" } } },
      ],
      pageList: ["get", "/api/vault/pages"],
      folders: ["get", "/api/vault/folders"],
    } as const;
    for (const key of Object.values(keys)) {
      queryClient.setQueryData(key, { cached: true });
    }
    const { result } = renderHook(() => useResolveConflict(), {
      wrapper: wrapper(queryClient),
    });

    await result.current.mutateAsync(request);

    expect(post).toHaveBeenCalledWith("/api/vault/sync/conflicts/resolve", {
      body: request,
    });
    for (const [scope, key] of Object.entries(keys)) {
      expect(queryClient.getQueryState(key)?.isInvalidated, scope).toBe(true);
    }
  });

  it("keeps a 409's revision_conflict code and a 500's message", async () => {
    const post = vi.spyOn(fetchClient, "POST");
    post.mockResolvedValueOnce({
      error: {
        error: "stale",
        status: 409,
        detail: { code: "revision_conflict" },
      },
      response: new Response(null, { status: 409 }),
    } as never);
    post.mockResolvedValueOnce({
      error: {
        error:
          "notes/plan.md was saved, but the Conflict Copy could not be moved to the Rubbish Bin and remains",
        status: 500,
      },
      response: new Response(null, { status: 500 }),
    } as never);
    const queryClient = freshQueryClient();
    const { result } = renderHook(() => useResolveConflict(), {
      wrapper: wrapper(queryClient),
    });

    await expect(result.current.mutateAsync(request)).rejects.toMatchObject({
      status: 409,
      code: "revision_conflict",
    });
    await expect(result.current.mutateAsync(request)).rejects.toMatchObject({
      status: 500,
      code: undefined,
      message:
        "notes/plan.md was saved, but the Conflict Copy could not be moved to the Rubbish Bin and remains",
    });
  });
});
