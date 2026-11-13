import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryRow } from "#/api/bases";
import { fetchClient } from "#/api/client";
import { invalidatePageContent } from "#/api/keys";
import { useMeetingHistory } from "#/api/meetingHistory";

function setup() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        staleTime: Infinity,
        throwOnError: true,
      },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

const meetings: QueryRow[] = [
  {
    id: "recent-meeting",
    path: "meetings/recent.md",
    title: "Recent one-to-one",
    kind: "MEETING",
    columns: { occurred_at: "2026-11-12T10:00:00Z" },
  },
  {
    id: "undated-meeting",
    path: "meetings/undated.md",
    title: "Undated one-to-one",
    kind: "MEETING",
    columns: { occurred_at: null },
  },
];

function flatResponse(rows: QueryRow[]) {
  return {
    data: { shape: "flat" as const, rows, total: rows.length, aggregates: [] },
    response: new Response(),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("useMeetingHistory", () => {
  it.each([
    { path: "meetings/current.md", attendee: null },
    { path: "", attendee: "people/alex.md" },
  ])("does not request history for a disabled source: %j", (props) => {
    const post = vi.spyOn(fetchClient, "POST");
    const { result } = renderHook(
      () => useMeetingHistory(props.path, props.attendee),
      { wrapper: setup().wrapper },
    );
    expect(post).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
  });

  it("keeps attendee and source-page caches separate without showing stale rows", async () => {
    const post = vi
      .spyOn(fetchClient, "POST")
      .mockResolvedValueOnce(flatResponse(meetings))
      .mockResolvedValueOnce(flatResponse([]))
      .mockResolvedValueOnce(flatResponse(meetings.slice(1)));
    const original = { path: "meetings/current.md", attendee: "people/alex.md" };
    const { result, rerender } = renderHook(
      ({ path, attendee }) => useMeetingHistory(path, attendee),
      { initialProps: original, wrapper: setup().wrapper },
    );
    await waitFor(() => expect(result.current.data).toEqual(meetings));

    rerender({ ...original, attendee: "people/blair.md" });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toEqual([]));

    rerender({ ...original, path: "meetings/another.md" });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toEqual([meetings[1]]));

    rerender(original);
    await waitFor(() => expect(result.current.data).toEqual(meetings));
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("refreshes active history after page content invalidation", async () => {
    vi.spyOn(fetchClient, "POST")
      .mockResolvedValueOnce(flatResponse(meetings))
      .mockResolvedValueOnce(flatResponse([]));
    const { client, wrapper } = setup();
    const { result } = renderHook(
      () => useMeetingHistory("meetings/current.md", "people/alex.md"),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toEqual(meetings));
    invalidatePageContent(client, "meetings/recent.md");
    await waitFor(() => expect(result.current.data).toEqual([]));
  });

  it("orders actual instants across UTC offsets, then undated rows by path", async () => {
    const rows: QueryRow[] = [
      {
        id: "a",
        kind: "MEETING",
        path: "a.md",
        columns: { occurred_at: "2026-11-12T10:00:00+05:00" },
      },
      {
        id: "b",
        kind: "MEETING",
        path: "b.md",
        columns: { occurred_at: "2026-11-12T09:00:00Z" },
      },
      {
        id: "c",
        kind: "MEETING",
        path: "c.md",
        columns: { occurred_at: "2026-11-12T04:00:00-05:00" },
      },
      { id: "d", kind: "MEETING", path: "d.md", columns: { occurred_at: null } },
      { id: "e", kind: "MEETING", path: "e.md", columns: {} },
      {
        id: "f",
        kind: "MEETING",
        path: "f.md",
        columns: { occurred_at: "invalid" },
      },
    ];
    vi.spyOn(fetchClient, "POST").mockResolvedValueOnce(flatResponse(rows));
    const { result } = renderHook(
      () => useMeetingHistory("meetings/current.md", "people/alex.md"),
      { wrapper: setup().wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((row) => row.id)).toEqual([
      "b",
      "c",
      "a",
      "d",
      "e",
      "f",
    ]);
  });

  it("keeps request failures local even when queries globally throw", async () => {
    const failure = new Error("Meeting service unavailable");
    vi.spyOn(fetchClient, "POST").mockRejectedValueOnce(failure);
    const { result } = renderHook(
      () => useMeetingHistory("meetings/current.md", "people/alex.md"),
      { wrapper: setup().wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBe(failure);
    expect(result.current.data).toBeUndefined();
  });

  it("reports grouped output as a local error instead of an empty history", async () => {
    vi.spyOn(fetchClient, "POST").mockResolvedValueOnce({
      data: { shape: "grouped", groups: [] },
      response: new Response(),
    });
    const { result } = renderHook(
      () => useMeetingHistory("meetings/current.md", "people/alex.md"),
      { wrapper: setup().wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/meeting history.*flat/i);
  });
});
