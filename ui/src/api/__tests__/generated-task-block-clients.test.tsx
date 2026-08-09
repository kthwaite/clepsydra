import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAssignBlockId } from "#/api/blocks";
import { fetchClient } from "#/api/client";
import { useToggleTaskStatus } from "#/api/tasks";

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("generated task client", () => {
  it("updates task status through the documented operation", async () => {
    const task = {
      block_id: "task-1",
      content: "Ship it",
      status: "done",
      properties: { status: "done" },
      page_path: "tasks/ship.md",
      page_title: "Ship",
      span_start: 12,
      span_end: 24,
    };
    const put = vi.spyOn(fetchClient, "PUT").mockResolvedValue({
      data: task,
      error: undefined,
      response: new Response(null, { status: 200 }),
    } as never);
    const { result } = renderHook(() => useToggleTaskStatus(), {
      wrapper: wrapper(),
    });

    await result.current.mutateAsync({
      pagePath: task.page_path,
      spanStart: task.span_start,
      status: "done",
    });

    expect(put).toHaveBeenCalledWith("/api/vault/tasks/status", {
      body: {
        page_path: task.page_path,
        span_start: task.span_start,
        status: "done",
      },
    });
  });
});

describe("generated block client", () => {
  it("assigns a block ID through the documented operation", async () => {
    const post = vi.spyOn(fetchClient, "POST").mockResolvedValue({
      data: { block_id: "block-1" },
      error: undefined,
      response: new Response(null, { status: 200 }),
    } as never);
    const { result } = renderHook(() => useAssignBlockId(), {
      wrapper: wrapper(),
    });

    await result.current.mutateAsync({
      page_path: "notes/example.md",
      span_start: 42,
    });

    expect(post).toHaveBeenCalledWith("/api/vault/blocks/assign-id", {
      body: { page_path: "notes/example.md", span_start: 42 },
    });
  });
});
