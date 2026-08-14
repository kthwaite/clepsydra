import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
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
    const listKey = queryKeys.rubbish.all;
    const detailKey = [
      "get",
      "/api/vault/rubbish/{item_id}",
      { params: { path: { item_id: "item-1" } } },
    ] as const;
    client.setQueryData(listKey, { items: [] });
    client.setQueryData(detailKey, { item_id: "item-1" });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useRestoreRubbishItem(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync("item-1");
    });

    expect(transport.post).toHaveBeenCalledWith(
      "/api/vault/rubbish/{item_id}/restore",
      { params: { path: { item_id: "item-1" } } },
    );
    expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true);
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
    const listKey = queryKeys.rubbish.all;
    const detailKey = [
      "get",
      "/api/vault/rubbish/{item_id}",
      { params: { path: { item_id: "item-1" } } },
    ] as const;
    const pageKey = ["get", "/api/vault/pages"] as const;
    client.setQueryData(listKey, { items: [] });
    client.setQueryData(detailKey, { item_id: "item-1" });
    client.setQueryData(pageKey, { items: [] });
    const purge = renderHook(() => usePurgeRubbishItem(), { wrapper });
    const empty = renderHook(() => useEmptyRubbish(), { wrapper });

    await act(async () => {
      await purge.result.current.mutateAsync("item-1");
    });
    expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(pageKey)?.isInvalidated).toBe(false);

    client.setQueryData(listKey, { items: [] });
    client.setQueryData(detailKey, { item_id: "item-1" });
    await act(async () => {
      await empty.result.current.mutateAsync();
    });
    expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(pageKey)?.isInvalidated).toBe(false);

    expect(transport.delete).toHaveBeenNthCalledWith(
      1,
      "/api/vault/rubbish/{item_id}",
      { params: { path: { item_id: "item-1" } } },
    );
    expect(transport.delete).toHaveBeenNthCalledWith(
      2,
      "/api/vault/rubbish",
    );
  });

  it("invalidates rubbish once for each rejected purge settlement", async () => {
    transport.delete
      .mockResolvedValueOnce({
        data: undefined,
        error: new Error("purge failed after applying"),
      })
      .mockResolvedValueOnce({
        data: undefined,
        error: new Error("purge rejected before applying"),
      });
    const { client, wrapper } = harness();
    const listKey = queryKeys.rubbish.all;
    const detailKey = [
      "get",
      "/api/vault/rubbish/{item_id}",
      { params: { path: { item_id: "item-1" } } },
    ] as const;
    const fetchList = vi.fn(async () => ({ items: [] }));
    const fetchDetail = vi.fn(async () => ({ item_id: "item-1" }));
    const listObserver = new QueryObserver(client, {
      queryKey: listKey,
      queryFn: fetchList,
    });
    const unsubscribe = listObserver.subscribe(() => undefined);
    await waitFor(() =>
      expect(listObserver.getCurrentResult().isSuccess).toBe(true),
    );
    await client.fetchQuery({ queryKey: detailKey, queryFn: fetchDetail });
    const { result } = renderHook(() => usePurgeRubbishItem(), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync("item-1")).rejects.toThrow(
        "purge failed after applying",
      );
    });
    await waitFor(() =>
      expect(listObserver.getCurrentResult().isFetching).toBe(false),
    );
    expect(fetchList).toHaveBeenCalledTimes(2);
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(fetchDetail).toHaveBeenCalledTimes(1);

    client.setQueryData(detailKey, { item_id: "item-1" });
    await act(async () => {
      await expect(result.current.mutateAsync("item-1")).rejects.toThrow(
        "purge rejected before applying",
      );
    });
    await waitFor(() =>
      expect(listObserver.getCurrentResult().isFetching).toBe(false),
    );
    expect(fetchList).toHaveBeenCalledTimes(3);
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(fetchDetail).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("invalidates rubbish once when Empty Bin rejects", async () => {
    transport.delete.mockResolvedValue({
      data: undefined,
      error: new Error("empty failed after applying"),
    });
    const { client, wrapper } = harness();
    const listKey = queryKeys.rubbish.all;
    const detailKey = [
      "get",
      "/api/vault/rubbish/{item_id}",
      { params: { path: { item_id: "item-1" } } },
    ] as const;
    const adjacentKey = ["get", "/api/vault/rubbish-bin"] as const;
    const fetchList = vi.fn(async () => ({ items: [] }));
    const fetchDetail = vi.fn(async () => ({ item_id: "item-1" }));
    const fetchAdjacent = vi.fn(async () => ({ items: [] }));
    const listObserver = new QueryObserver(client, {
      queryKey: listKey,
      queryFn: fetchList,
    });
    const adjacentObserver = new QueryObserver(client, {
      queryKey: adjacentKey,
      queryFn: fetchAdjacent,
    });
    const unsubscribe = listObserver.subscribe(() => undefined);
    const unsubscribeAdjacent = adjacentObserver.subscribe(() => undefined);
    await waitFor(() =>
      expect(listObserver.getCurrentResult().isSuccess).toBe(true),
    );
    await waitFor(() =>
      expect(adjacentObserver.getCurrentResult().isSuccess).toBe(true),
    );
    await client.fetchQuery({ queryKey: detailKey, queryFn: fetchDetail });
    const { result } = renderHook(() => useEmptyRubbish(), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow(
        "empty failed after applying",
      );
    });
    await waitFor(() =>
      expect(listObserver.getCurrentResult().isFetching).toBe(false),
    );
    expect(fetchList).toHaveBeenCalledTimes(2);
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(fetchDetail).toHaveBeenCalledTimes(1);
    expect(fetchAdjacent).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(adjacentKey)?.isInvalidated).toBe(false);
    expect(transport.delete).toHaveBeenCalledWith("/api/vault/rubbish");
    unsubscribe();
    unsubscribeAdjacent();
  });
});
