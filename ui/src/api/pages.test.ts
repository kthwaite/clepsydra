import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchClient } from "#/api/client";
import { queryKeys } from "#/api/keys";
import {
  useAssignBulk,
  useAssignPage,
  useUpdatePage,
} from "#/api/pages";

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

function propertyProjectionKey(uuid: string) {
  return [
    "get",
    queryKeys.pages.propertyProjectionPath,
    { params: { path: { uuid } } },
  ] as const;
}

afterEach(() => vi.restoreAllMocks());

describe("assign hooks", () => {
  it("are exported", () => {
    expect(typeof useAssignPage).toBe("function");
    expect(typeof useAssignBulk).toBe("function");
  });
});

describe("useUpdatePage", () => {
  it("refetches an active authoritative property projection after a body update", async () => {
    const { client, wrapper } = harness();
    const uuid = "page-id";
    const path = "notes/current.md";
    const unrelatedKey = propertyProjectionKey("unrelated-page");
    client.setQueryData(unrelatedKey, { preview: "unrelated" });
    const before = {
      preview: {
        fields: [{ key: "body", label: "Summary", value: "Before" }],
        remaining_count: 0,
      },
    };
    const after = {
      preview: {
        fields: [{ key: "body", label: "Summary", value: "After" }],
        remaining_count: 0,
      },
    };
    let projectionFetches = 0;
    const observer = new QueryObserver(client, {
      queryKey: propertyProjectionKey(uuid),
      queryFn: async () => {
        projectionFetches += 1;
        return projectionFetches === 1 ? before : after;
      },
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await waitFor(() => expect(observer.getCurrentResult().data).toBe(before));

    vi.spyOn(fetchClient, "PUT").mockResolvedValue({
      data: { path, meta: { id: uuid }, body: "After" },
      error: undefined,
      response: new Response(null, { status: 200 }),
    } as never);
    const update = renderHook(() => useUpdatePage(), { wrapper });

    await act(() =>
      update.result.current.mutateAsync({
        params: { path: { path } },
        body: { expected_revision: "revision-a", body: "After" },
      }),
    );

    await waitFor(() =>
      expect(observer.getCurrentResult().data).toStrictEqual(after),
    );
    expect(projectionFetches).toBe(2);
    expect(client.getQueryState(unrelatedKey)?.isInvalidated).toBe(false);
    unsubscribe();
  });
});
