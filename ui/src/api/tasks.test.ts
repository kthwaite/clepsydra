import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "#/api/keys";
import { useAgenda } from "#/api/tasks";

const { fetchMock, getMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  getMock: vi.fn(),
}));

vi.mock("#/api/client", () => ({
  fetchClient: { GET: getMock },
}));

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function freshQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

afterEach(() => {
  fetchMock.mockReset();
  getMock.mockReset();
});

describe("useAgenda", () => {
  it("fetches the consolidated Agenda for a date and preserves item discriminators", async () => {
    const fixture = {
      overdue: [],
      today: [
        {
          block_id: "block-1",
          content: "Send the brief",
          kind: "todo",
          page_path: "journals/2026-08-26.md",
          page_title: "2026-08-26",
          properties: { due: "2026-08-26" },
          span_end: 24,
          span_start: 8,
          status: "todo",
        },
        {
          code: "TSK-0001",
          due: "2026-08-26",
          hold: null,
          id: "00000000-0000-0000-0000-000000000001",
          kind: "task",
          path: "tasks/TSK-0001.md",
          priority: "HIGH",
          project: "clepsydra",
          status: "FIELD",
          title: "Ship Agenda",
        },
      ],
      upcoming: [],
      undated: [],
    };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    getMock.mockImplementation(
      async (
        _path: string,
        options: { params: { query: { today: string } } },
      ) => {
        const today = options.params.query.today;
        const response = await fetchMock(
          `/api/vault/agenda?today=${today}`,
          {},
        );
        return {
          data: await response.json(),
          error: undefined,
          response,
        };
      },
    );
    const queryClient = freshQueryClient();

    const { result } = renderHook(() => useAgenda("2026-08-26"), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/vault/agenda?today=2026-08-26"),
      expect.anything(),
    );
    expect(getMock).toHaveBeenCalledWith("/api/vault/agenda", {
      params: { query: { today: "2026-08-26" } },
    });
    expect(result.current.data?.today.map((item) => item.kind)).toEqual([
      "todo",
      "task",
    ]);
    expect(
      queryClient.getQueryData(queryKeys.agenda.byDate("2026-08-26")),
    ).toEqual(fixture);
  });
});
