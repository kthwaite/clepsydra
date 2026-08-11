import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchClient } from "#/api/client";
import type { TagCount } from "#/api/types";
import { useTagSuggestions, useTags } from "../index";

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

interface TagResponse {
  data: TagCount[];
  error: undefined;
  response: Response;
}

function tagResponse(data: TagCount[]): TagResponse {
  return {
    data,
    error: undefined,
    response: new Response(null, { status: 200 }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tag query hooks", () => {
  it("preserves the complete unparameterized vocabulary query", async () => {
    const vocabulary = Array.from({ length: 15 }, (_, index) => ({
      tag: `tag-${index}`,
      count: 15 - index,
      computed_count: 0,
    }));
    const get = vi
      .spyOn(fetchClient, "GET")
      .mockResolvedValue(tagResponse(vocabulary));

    const { result } = renderHook(() => useTags(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(vocabulary);
    expect(get).toHaveBeenCalledWith("/api/vault/index/tags", {
      signal: expect.any(AbortSignal),
    });
  });

  it("requests a bounded server-filtered suggestion set", async () => {
    const suggestions = Array.from({ length: 12 }, (_, index) => ({
      tag: index === 0 ? "clepsydra" : `clep-${index}`,
      count: 12 - index,
      computed_count: 0,
    }));
    const get = vi
      .spyOn(fetchClient, "GET")
      .mockResolvedValue(tagResponse(suggestions));

    const { result } = renderHook(() => useTagSuggestions("clep", 12, true), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(suggestions);
    expect(result.current.data).toHaveLength(12);
    expect(get).toHaveBeenCalledWith("/api/vault/index/tags", {
      params: { query: { q: "clep", limit: 12 } },
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps the newest query result when requests resolve out of order", async () => {
    const clep = deferred<TagResponse>();
    const clepsydra = deferred<TagResponse>();
    const get = vi
      .spyOn(fetchClient, "GET")
      .mockReturnValueOnce(clep.promise as never)
      .mockReturnValueOnce(clepsydra.promise as never);

    const { result, rerender } = renderHook(
      ({ query }) => useTagSuggestions(query, 12, true),
      { initialProps: { query: "clep" }, wrapper: wrapper() },
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    rerender({ query: "clepsydra" });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    await act(async () => {
      clepsydra.resolve(
        tagResponse([{ tag: "clepsydra", count: 9, computed_count: 0 }]),
      );
      await clepsydra.promise;
    });
    await waitFor(() =>
      expect(result.current.data).toEqual([
        { tag: "clepsydra", count: 9, computed_count: 0 },
      ]),
    );

    await act(async () => {
      clep.resolve(
        tagResponse([{ tag: "clep-old", count: 99, computed_count: 0 }]),
      );
      await clep.promise;
    });
    expect(result.current.data).toEqual([
      { tag: "clepsydra", count: 9, computed_count: 0 },
    ]);
  });
});
