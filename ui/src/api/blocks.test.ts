import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockApiError, useBlock } from "#/api/blocks";
import { fetchClient } from "#/api/client";

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

function retryingClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 3, retryDelay: 0, throwOnError: false },
    },
  });
}

const block = {
  block_id: "abc123DEF0",
  block_type: "paragraph",
  content: "Important note",
  page_path: "source.md",
  page_title: "Source",
  span_start: 10,
  span_end: 24,
  properties: {},
};

function failedResponse(status: number) {
  return {
    error: { error: status === 404 ? "Block not found" : "Request failed" },
    response: new Response(null, { status }),
  } as never;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useBlock", () => {
  it("settles a 404 without retrying the unavailable block", async () => {
    const get = vi
      .spyOn(fetchClient, "GET")
      .mockResolvedValue(failedResponse(404));
    const { result } = renderHook(() => useBlock("unknown1234"), {
      wrapper: wrapper(retryingClient()),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(get).toHaveBeenCalledOnce();
    expect(result.current.error).toBeInstanceOf(BlockApiError);
    expect(result.current.error).toMatchObject({ status: 404 });
  });

  it("retains retry behavior for a transient block failure", async () => {
    const get = vi
      .spyOn(fetchClient, "GET")
      .mockResolvedValueOnce(failedResponse(503))
      .mockResolvedValueOnce({ data: block } as never);
    const { result } = renderHook(() => useBlock("abc123DEF0"), {
      wrapper: wrapper(retryingClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual(block);
  });
});
