import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlockApiError } from "#/api/blocks";
import { queryKeys } from "#/api/keys";
import { useVaultEvents } from "#/hooks/useVaultEvents";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {}
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("useVaultEvents", () => {
  it("invalidates academic and task telemetry queries when the index changes", () => {
    const client = new QueryClient();
    const academicKey = ["get", "/api/vault/academic/works"] as const;
    const taskHistoryKey = queryKeys.tasks.history(undefined);
    const burndownKey = queryKeys.agenda.cycleBurndown("C-01");
    client.setQueryData(academicKey, { items: [], total: 0 });
    client.setQueryData(taskHistoryKey, { days: [] });
    client.setQueryData(burndownKey, { cycle: "C-01", points: [] });

    const { unmount } = renderHook(() => useVaultEvents(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    const source = FakeEventSource.instances[0];

    act(() => {
      source?.onmessage?.({
        data: JSON.stringify({
          type: "index_changed",
          upserted: ["*"],
          removed: [],
        }),
      } as MessageEvent<string>);
    });

    expect(client.getQueryState(academicKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(taskHistoryKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(burndownKey)?.isInvalidated).toBe(true);
    unmount();
  });

  it("invalidates the board query on index_changed", async () => {
    const client = new QueryClient();
    const boardKey = queryKeys.board.all;
    client.setQueryData(boardKey, {});

    const { unmount } = renderHook(() => useVaultEvents(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    const source = FakeEventSource.instances[0];

    act(() => {
      source?.onmessage?.({
        data: JSON.stringify({
          type: "index_changed",
          upserted: ["*"],
          removed: [],
        }),
      } as MessageEvent<string>);
    });

    expect(client.getQueryState(boardKey)?.isInvalidated).toBe(true);
    unmount();
  });

  it("refetches an active page-property projection when the Base registry changes", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const projectionKey = [
      "get",
      "/api/vault/pages/by-id/{uuid}/properties",
      { params: { path: { uuid: "page-alpha" } } },
    ] as const;
    let revision = 0;
    const loadProjection = vi.fn(async () => ({
      revision: `page-rev-${++revision}`,
    }));
    const observer = new QueryObserver(client, {
      queryKey: projectionKey,
      queryFn: loadProjection,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await waitFor(() => {
      expect(observer.getCurrentResult().data).toEqual({
        revision: "page-rev-1",
      });
    });

    const { unmount } = renderHook(() => useVaultEvents(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    const source = FakeEventSource.instances[0];

    act(() => {
      source?.onmessage?.({
        data: JSON.stringify({ type: "base_registry_changed" }),
      } as MessageEvent<string>);
    });

    await waitFor(() => {
      expect(observer.getCurrentResult().data).toEqual({
        revision: "page-rev-2",
      });
    });
    expect(loadProjection).toHaveBeenCalledTimes(2);
    unsubscribe();
    unmount();
  });

  it("fails closed for changed block details without letting an old response repopulate them", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const changedKey = queryKeys.blocks.detail("abc123DEF0");
    const unchangedKey = queryKeys.blocks.detail("unchanged01");
    const searchKey = queryKeys.blocks.search("source", 8);
    const changedBlock = {
      block_id: "abc123DEF0",
      block_type: "paragraph",
      content: "protected plaintext",
      page_path: "source.md",
    };
    const unchangedBlock = {
      ...changedBlock,
      block_id: "unchanged01",
      page_path: "other.md",
    };
    client.setQueryData(changedKey, changedBlock);
    client.setQueryData(unchangedKey, unchangedBlock);
    client.setQueryData(searchKey, [changedBlock]);

    let resolveOldLookup!: (value: typeof changedBlock) => void;
    let rejectNotFound!: (error: BlockApiError) => void;
    const oldResponse = new Promise<typeof changedBlock>((resolve) => {
      resolveOldLookup = resolve;
    });
    const eventualNotFound = new Promise<never>((_resolve, reject) => {
      rejectNotFound = reject;
    });
    let lookupCount = 0;
    const observer = new QueryObserver(client, {
      queryKey: changedKey,
      queryFn: () => (lookupCount++ === 0 ? oldResponse : eventualNotFound),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    expect(observer.getCurrentResult().fetchStatus).toBe("fetching");

    const { unmount } = renderHook(() => useVaultEvents(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    const source = FakeEventSource.instances[0];

    act(() => {
      source?.onmessage?.({
        data: JSON.stringify({
          type: "index_changed",
          upserted: ["source.md"],
          removed: [],
        }),
      } as MessageEvent<string>);
    });

    expect(client.getQueryData(changedKey)).toBeUndefined();
    expect(client.getQueryData(unchangedKey)).toEqual(unchangedBlock);
    expect(client.getQueryState(searchKey)?.isInvalidated).toBe(true);

    resolveOldLookup(changedBlock);
    await Promise.resolve();
    expect(client.getQueryData(changedKey)).toBeUndefined();

    rejectNotFound(new BlockApiError("Block not found", 404));
    await waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    unsubscribe();
    unmount();
  });

  it("cancels an unseeded lookup when an external index event makes its path unknowable", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const detailKey = queryKeys.blocks.detail("abc123DEF0");
    const block = {
      block_id: "abc123DEF0",
      block_type: "paragraph",
      content: "protected plaintext",
      page_path: "source.md",
    };
    let resolveOldLookup!: (value: typeof block) => void;
    let rejectNotFound!: (error: BlockApiError) => void;
    const oldResponse = new Promise<typeof block>((resolve) => {
      resolveOldLookup = resolve;
    });
    const eventualNotFound = new Promise<never>((_resolve, reject) => {
      rejectNotFound = reject;
    });
    let lookupCount = 0;
    const observer = new QueryObserver(client, {
      queryKey: detailKey,
      queryFn: () => (lookupCount++ === 0 ? oldResponse : eventualNotFound),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(observer.getCurrentResult().fetchStatus).toBe("fetching");

    const { unmount } = renderHook(() => useVaultEvents(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    const source = FakeEventSource.instances[0];

    act(() => {
      source?.onmessage?.({
        data: JSON.stringify({
          type: "index_changed",
          upserted: ["source.md"],
          removed: [],
        }),
      } as MessageEvent<string>);
    });

    expect(lookupCount).toBeGreaterThan(1);
    expect(client.getQueryData(detailKey)).toBeUndefined();

    resolveOldLookup(block);
    await Promise.resolve();
    expect(client.getQueryData(detailKey)).toBeUndefined();

    rejectNotFound(new BlockApiError("Block not found", 404));
    await waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    unsubscribe();
    unmount();
  });
});
