import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockApiError } from "#/api/blocks";
import { fetchClient } from "#/api/client";
import { useProtectPage } from "#/api/encryption";
import { queryKeys } from "#/api/keys";

const cachedBlock = {
  block_id: "abc123DEF0",
  block_type: "paragraph",
  content: "protected plaintext",
  page_path: "notes/private.md",
};

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

afterEach(() => vi.restoreAllMocks());

describe("useProtectPage", () => {
  it("synchronously clears matching block plaintext and cancels the old lookup on success", async () => {
    const { client, wrapper } = harness();
    const detailKey = queryKeys.blocks.detail(cachedBlock.block_id);
    const unrelatedKey = queryKeys.blocks.detail("unrelated01");
    const searchKey = queryKeys.blocks.search("private", 8);
    const unrelatedBlock = {
      ...cachedBlock,
      block_id: "unrelated01",
      page_path: "notes/public.md",
    };
    client.setQueryData(detailKey, cachedBlock);
    client.setQueryData(unrelatedKey, unrelatedBlock);
    client.setQueryData(searchKey, [cachedBlock]);

    let resolveOldLookup!: (value: typeof cachedBlock) => void;
    let rejectNotFound!: (error: BlockApiError) => void;
    const oldResponse = new Promise<typeof cachedBlock>((resolve) => {
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
    expect(observer.getCurrentResult().fetchStatus).toBe("fetching");

    vi.spyOn(fetchClient, "POST").mockResolvedValue({
      data: { path: cachedBlock.page_path },
      error: undefined,
      response: new Response(null, { status: 200 }),
    } as never);
    const { result } = renderHook(() => useProtectPage(), { wrapper });

    await act(() =>
      result.current.mutateAsync({
        params: { path: { uuid: "page-id" } },
        body: {
          expected_revision: "revision-a",
          body: "encrypted armor",
          encryption: { format: "age", version: 1, key_id: "key-id" },
        },
      }),
    );

    expect(client.getQueryData(detailKey)).toBeUndefined();
    expect(client.getQueryData(unrelatedKey)).toEqual(unrelatedBlock);
    expect(client.getQueryState(searchKey)?.isInvalidated).toBe(true);

    resolveOldLookup(cachedBlock);
    await Promise.resolve();
    expect(client.getQueryData(detailKey)).toBeUndefined();

    rejectNotFound(new BlockApiError("Block not found", 404));
    await waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    unsubscribe();
  });

  it("cancels an unseeded pre-protection lookup before it can cache plaintext", async () => {
    const { client, wrapper } = harness();
    const detailKey = queryKeys.blocks.detail(cachedBlock.block_id);
    let resolveOldLookup!: (value: typeof cachedBlock) => void;
    let rejectNotFound!: (error: BlockApiError) => void;
    const oldResponse = new Promise<typeof cachedBlock>((resolve) => {
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

    vi.spyOn(fetchClient, "POST").mockResolvedValue({
      data: { path: cachedBlock.page_path },
      error: undefined,
      response: new Response(null, { status: 200 }),
    } as never);
    const { result } = renderHook(() => useProtectPage(), { wrapper });

    await act(() =>
      result.current.mutateAsync({
        params: { path: { uuid: "page-id" } },
        body: {
          expected_revision: "revision-a",
          body: "encrypted armor",
          encryption: { format: "age", version: 1, key_id: "key-id" },
        },
      }),
    );

    expect(lookupCount).toBeGreaterThan(1);
    expect(client.getQueryData(detailKey)).toBeUndefined();

    resolveOldLookup(cachedBlock);
    await Promise.resolve();
    expect(client.getQueryData(detailKey)).toBeUndefined();

    rejectNotFound(new BlockApiError("Block not found", 404));
    await waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    unsubscribe();
  });
});
