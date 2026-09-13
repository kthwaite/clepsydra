import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Component, createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchClient } from "#/api/client";
import { queryKeys } from "#/api/keys";
import {
  useAssignBulk,
  useAssignPage,
  usePages,
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

/** Catches a render-phase throw so a test can assert one did or didn't
 *  happen, instead of letting it escape as an uncaught test failure. */
class CatchBoundary extends Component<
  { onError: (error: unknown) => void; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

/** A query client whose *global* default is throwOnError: true — the app's
 *  real default (see #/lib/queryClient) — so this proves usePages's own
 *  `throwOnError: false` is what keeps an offline_uncached error from
 *  crashing into FolioBoundary, not merely an absence of any default. */
function throwOnErrorHarness(onError: (error: unknown) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, throwOnError: true } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client },
      createElement(CatchBoundary, { onError, children }),
    );
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

describe("usePages", () => {
  it("settles to isError instead of throwing an offline_uncached response, even under a throwOnError:true default", async () => {
    const boundaryErrors: unknown[] = [];
    const { wrapper } = throwOnErrorHarness((error) =>
      boundaryErrors.push(error),
    );
    vi.spyOn(fetchClient, "GET").mockResolvedValue({
      data: undefined,
      error: { code: "offline_uncached", url: "/api/vault/pages" },
      response: new Response(null, { status: 503 }),
    } as never);

    const { result } = renderHook(() => usePages(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(boundaryErrors).toEqual([]);
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
