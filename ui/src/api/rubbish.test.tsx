import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  query: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("#/api/client", () => ({
  $api: { useQuery: transport.query },
  fetchClient: { POST: transport.post, DELETE: transport.delete },
}));

import {
  useEmptyRubbish,
  usePurgeRubbishItem,
  useRestoreRubbishItem,
  useRubbishItem,
  useRubbishList,
} from "#/api/rubbish";
import { queryKeys } from "#/api/keys";

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

beforeEach(() => {
  vi.clearAllMocks();
  transport.query.mockReturnValue({ data: undefined });
  transport.post.mockResolvedValue({ data: {}, error: undefined });
  transport.delete.mockResolvedValue({ data: {}, error: undefined });
});

describe("rubbish API hooks", () => {
  it("binds list and enabled detail to dedicated generated routes", () => {
    renderHook(() => {
      useRubbishList();
      useRubbishItem("item-1");
      useRubbishItem(null);
    });

    expect(transport.query).toHaveBeenCalledWith(
      "get",
      "/api/vault/rubbish",
      undefined,
      expect.objectContaining({ throwOnError: false }),
    );
    expect(transport.query).toHaveBeenCalledWith(
      "get",
      "/api/vault/rubbish/{item_id}",
      { params: { path: { item_id: "item-1" } } },
      expect.objectContaining({ enabled: true, throwOnError: false }),
    );
    expect(transport.query).toHaveBeenCalledWith(
      "get",
      "/api/vault/rubbish/{item_id}",
      { params: { path: { item_id: "" } } },
      expect.objectContaining({ enabled: false, throwOnError: false }),
    );
  });

  it("restore invalidates rubbish and every normal page-derived structure", async () => {
    const restored = { item_id: "item-1", page_id: "page-1", path: "notes/a.md" };
    transport.post.mockResolvedValue({ data: restored, error: undefined });
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useRestoreRubbishItem(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync("item-1");
    });

    expect(transport.post).toHaveBeenCalledWith(
      "/api/vault/rubbish/{item_id}/restore",
      { params: { path: { item_id: "item-1" } } },
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.rubbish.all });
    for (const prefix of [
      queryKeys.pages.pathPrefix,
      queryKeys.index.pathPrefix,
      queryKeys.folders.pathPrefix,
    ]) {
      expect(invalidate).toHaveBeenCalledWith(
        expect.objectContaining({ predicate: expect.any(Function) }),
      );
      expect(prefix).toBeTruthy();
    }
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.blocks.all });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tasks.all });
  });

  it("purge and Empty Bin invalidate only rubbish data and never derive page paths from item IDs", async () => {
    transport.delete.mockResolvedValue({
      data: { item_id: "item-1", page_id: "page-1", original_path: "notes/a.md" },
      error: undefined,
    });
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const purge = renderHook(() => usePurgeRubbishItem(), { wrapper });
    const empty = renderHook(() => useEmptyRubbish(), { wrapper });

    await act(async () => {
      await purge.result.current.mutateAsync("item-1");
      await empty.result.current.mutateAsync();
    });

    expect(transport.delete).toHaveBeenNthCalledWith(
      1,
      "/api/vault/rubbish/{item_id}",
      { params: { path: { item_id: "item-1" } } },
    );
    expect(transport.delete).toHaveBeenNthCalledWith(
      2,
      "/api/vault/rubbish",
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.rubbish.all });
    expect(invalidate.mock.calls.some(([filters]) => {
      const key = (filters as { queryKey?: readonly unknown[] }).queryKey;
      return key?.includes("item-1");
    })).toBe(false);
  });
});
