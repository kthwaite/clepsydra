import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { queryClient as productionQueryClient } from "#/lib/queryClient";

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: productionQueryClient.getDefaultOptions(),
  });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe("queryClient default retry policy", () => {
  it("does not retry a query that rejects with the offline_uncached body", async () => {
    const client = freshClient();
    const queryFn = vi.fn(async () => {
      throw { code: "offline_uncached", url: "/api/vault/pages/notes%2Fa.md" };
    });

    const { result } = renderHook(
      () =>
        useQuery({
          queryKey: ["offline-retry-test"],
          queryFn,
          // Every real consumer hook opts out of the global throwOnError so
          // it can inspect isError/error itself instead of crashing the
          // render; do the same here so this test can observe the settled
          // state under the client's real (default) retry policy.
          throwOnError: false,
        }),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("retries a query that rejects with a plain Error", async () => {
    const client = freshClient();
    const queryFn = vi.fn(async () => {
      throw new Error("network blip");
    });

    const { result } = renderHook(
      () =>
        useQuery({
          queryKey: ["plain-error-retry-test"],
          queryFn,
          retryDelay: 0,
          throwOnError: false,
        }),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryFn.mock.calls.length).toBeGreaterThan(1);
  });
});
