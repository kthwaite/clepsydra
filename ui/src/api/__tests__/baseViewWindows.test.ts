import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBaseViewWindows } from "#/api/bases";
import { fetchClient } from "#/api/client";
import {
  type BaseEmbedConfig,
  embedScrollCap,
  nextWindowSize,
} from "#/components/bases/embed-query";

const capability = {
  view: "Reading",
  enabled: true,
  blockers: [],
  fields: [],
};

function row(id: number) {
  return {
    id: `row-${id}`,
    path: `p/${id}.md`,
    title: `Row ${id}`,
    kind: "BOOK",
    columns: {},
  };
}

function flatPage(ids: number[], total: number) {
  return {
    data: {
      revision: "rev-1",
      member_creation: capability,
      output: { shape: "flat", rows: ids.map(row), total },
    },
  };
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

function freshClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

const config: BaseEmbedConfig = { base: "books", view: "Reading" };

type PostSpy = { mock: { calls: unknown[][] } };

function requestedBodies(post: PostSpy) {
  return post.mock.calls.map(
    (call) => (call[1] as { body: { limit?: number; offset?: number } }).body,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("useBaseViewWindows", () => {
  it("asks for one window and reports the authoritative total", async () => {
    const post = vi
      .spyOn(fetchClient, "POST")
      .mockResolvedValue(flatPage([1, 2], 140) as never);
    const { result } = renderHook(() => useBaseViewWindows(config), {
      wrapper: wrapper(freshClient()),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedBodies(post)).toEqual([{ limit: 50, offset: 0 }]);
    expect(result.current.total).toBe(140);
    expect(result.current.loaded).toBe(2);
    expect(result.current.hasMore).toBe(true);
  });

  it("appends the next window at the offset the loaded rows reached", async () => {
    const post = vi.spyOn(fetchClient, "POST");
    post.mockResolvedValueOnce(flatPage([1, 2], 4) as never);
    post.mockResolvedValueOnce(flatPage([3, 4], 4) as never);
    const { result } = renderHook(() => useBaseViewWindows(config), {
      wrapper: wrapper(freshClient()),
    });

    await waitFor(() => expect(result.current.loaded).toBe(2));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loaded).toBe(4));

    expect(requestedBodies(post)[1]).toEqual({ limit: 50, offset: 2 });
    const output = result.current.data?.output;
    expect(output?.shape === "flat" && output.rows.map((r) => r.id)).toEqual([
      "row-1",
      "row-2",
      "row-3",
      "row-4",
    ]);
    expect(result.current.hasMore).toBe(false);
  });

  it("drops a row a concurrent insert pushed into two windows", async () => {
    const post = vi.spyOn(fetchClient, "POST");
    post.mockResolvedValueOnce(flatPage([1, 2], 4) as never);
    // A page was added above the window, so row 2 slid into the next one.
    post.mockResolvedValueOnce(flatPage([2, 3], 5) as never);
    const { result } = renderHook(() => useBaseViewWindows(config), {
      wrapper: wrapper(freshClient()),
    });

    await waitFor(() => expect(result.current.loaded).toBe(2));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loaded).toBe(3));

    const output = result.current.data?.output;
    expect(output?.shape === "flat" && output.rows.map((r) => r.id)).toEqual([
      "row-1",
      "row-2",
      "row-3",
    ]);
    // The freshest total wins.
    expect(result.current.total).toBe(5);
  });

  it("stops at the author's limit and never asks past it", async () => {
    const post = vi
      .spyOn(fetchClient, "POST")
      .mockResolvedValue(flatPage([1, 2, 3, 4, 5], 400) as never);
    const { result } = renderHook(
      () => useBaseViewWindows({ ...config, limit: 5 }),
      { wrapper: wrapper(freshClient()) },
    );

    await waitFor(() => expect(result.current.loaded).toBe(5));
    expect(requestedBodies(post)).toEqual([{ limit: 5, offset: 0 }]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.cappedBy).toBe("author");
    expect(result.current.total).toBe(400);
  });

  it("asks for the remainder of the author's limit, not a whole window", async () => {
    const post = vi.spyOn(fetchClient, "POST");
    post.mockResolvedValueOnce(
      flatPage(
        Array.from({ length: 50 }, (_, i) => i),
        400,
      ) as never,
    );
    post.mockResolvedValueOnce(flatPage([100, 101, 102], 400) as never);
    const { result } = renderHook(
      () => useBaseViewWindows({ ...config, limit: 53 }),
      { wrapper: wrapper(freshClient()) },
    );

    await waitFor(() => expect(result.current.loaded).toBe(50));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loaded).toBe(53));

    expect(requestedBodies(post)[1]).toEqual({ limit: 3, offset: 50 });
    expect(result.current.hasMore).toBe(false);
  });

  it("stops at the ceiling that bounds one embed's rows", async () => {
    const window = Array.from({ length: 50 }, (_, i) => i);
    const post = vi.spyOn(fetchClient, "POST");
    // Twenty windows of fifty reach the thousand-row ceiling.
    post.mockResolvedValue(flatPage(window, 4000) as never);
    const { result } = renderHook(() => useBaseViewWindows(config), {
      wrapper: wrapper(freshClient()),
    });

    await waitFor(() => expect(result.current.loaded).toBe(50));
    // Each window returns the same ids, so pretend they are distinct by
    // checking the request the hook makes rather than the rows it keeps.
    expect(nextWindowSize(undefined, 950)).toBe(50);
    expect(nextWindowSize(undefined, 1000)).toBe(0);
    expect(embedScrollCap(undefined, 1000)).toBe("ceiling");
    expect(embedScrollCap(20, 20)).toBe("author");
    expect(embedScrollCap(undefined, 200)).toBeUndefined();
  });

  it("never pages a grouped view", async () => {
    vi.spyOn(fetchClient, "POST").mockResolvedValue({
      data: {
        revision: "rev-1",
        member_creation: capability,
        output: {
          shape: "grouped",
          groups: [
            { key: "reading", total: 90, aggregates: [], rows: [row(1)] },
          ],
        },
      },
    } as never);
    const { result } = renderHook(() => useBaseViewWindows(config), {
      wrapper: wrapper(freshClient()),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.hasMore).toBe(false);
    expect(result.current.total).toBe(90);
  });

  it("stays idle until the embed names a Base and a view", async () => {
    const post = vi.spyOn(fetchClient, "POST");
    const { result } = renderHook(
      () => useBaseViewWindows({ base: "", view: "" }),
      { wrapper: wrapper(freshClient()) },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(post).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });
});
